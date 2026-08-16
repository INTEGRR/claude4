/**
 * Vollständigkeit: hier reißt der Faden, wenn Registry, Prozessdefinitionen
 * und Fixtures auseinanderlaufen.
 *
 *  - Jede Registry-Aktion sitzt in einem Prozessschritt, ist ausdrücklich
 *    `prozessfrei` — oder steht auf der SCHRUMPFENDEN Restliste unten.
 *  - Jeder Schrittverweis (Aktion, Dienst, Ereignis, Rolle) zeigt auf etwas,
 *    das existiert.
 *  - Jeder Statuswert der Belegmaschine ist einem Schritt zugeordnet oder
 *    steht auf der expliziten Unabgebildet-Liste (tote Zustände).
 *  - Jeder aktive Prozess hat eine Fixture mit gültigen Pfaden — der
 *    Testdatensatz wächst zwangsläufig mit den Prozessen mit.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { alleAktionen } from '../../src/modules/prozesse/registry/index.ts'
import { JOB_KATALOG } from '../../src/modules/prozesse/jobs-katalog.ts'
import { EREIGNISSE } from '../../src/modules/prozesse/ereignisse.ts'
import { ALL_ROLES } from '../../src/modules/auth/permissions.ts'
import { alleFixtures } from '../../src/modules/prozesse/fixtures/index.ts'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'

const DATENBANK = 'erp_prozess_check'

/**
 * Aktionen, deren Prozess noch nicht existiert (P4–P7 kommen in Phase 5/6).
 * Die Liste darf nur SCHRUMPFEN: sobald eine Aktion in einem aktiven
 * Prozessschritt auftaucht, muss ihr Eintrag hier verschwinden.
 */
const NOCH_OHNE_PROZESS = new Set([
  'lager.transfer_bestaetigen',
  'lager.transfer_stornieren',
  'lager.transfer_retoure',
  'lager.zaehlung_erfassen',
  'lager.zaehlung_buchen',
  'lager.ausschuss_buchen',
  'lager.beschaffung_ausfuehren',
])

/** Tote Statuswerte je Prozess: vorhanden im Enum, bewusst ohne Schritt. */
const UNABGEBILDET: Record<string, string[]> = {
  // draft/waiting sind Durchgangszustände vor der Bestätigung; cancel ist
  // der Abbruch außerhalb des Happy Path (Storno-Schritt folgt mit P5–P7).
  shopify_bestellung_versand: ['draft', 'waiting', 'cancel'],
}

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  if (h) await harnessEnde(h, DATENBANK)
})

interface SchrittZeile {
  prozess: string
  code: string
  art: string
  aktion: string | null
  job_kind: string | null
  ereignis: string | null
  rollen: string[] | null
  zustand: string | null
}

async function aktiveSchritte(): Promise<SchrittZeile[]> {
  const zeilen = await h.sql<SchrittZeile[]>`
    select p.code as prozess, s.code, s.art::text as art,
           s.aktion, s.job_kind, s.ereignis, s.rollen, s.zustand
    from prozesse p
    join prozess_schritte s on s.version_id = prozess_aktive_version(p.code)
    where p.aktiv`
  return zeilen.map((z) => ({ ...z }))
}

describe('Vollständigkeit: Registry ↔ Prozesse', () => {
  test('jede Aktion hat einen Schritt, ist prozessfrei oder steht auf der Restliste', async () => {
    const verwendet = new Set(
      (await aktiveSchritte()).map((s) => s.aktion).filter((a): a is string => Boolean(a)),
    )

    const fehlend: string[] = []
    const erledigt: string[] = []
    for (const [name, aktion] of alleAktionen()) {
      const imProzess = verwendet.has(name)
      if (imProzess && NOCH_OHNE_PROZESS.has(name)) erledigt.push(name)
      if (!imProzess && !aktion.prozessfrei && !NOCH_OHNE_PROZESS.has(name)) fehlend.push(name)
    }

    assert.deepEqual(
      fehlend,
      [],
      `Ohne Prozessschritt und weder prozessfrei noch auf der Restliste:\n  ${fehlend.join('\n  ')}`,
    )
    assert.deepEqual(
      erledigt,
      [],
      `Inzwischen im Prozess — von NOCH_OHNE_PROZESS streichen:\n  ${erledigt.join('\n  ')}`,
    )
  })

  test('jeder Schrittverweis zeigt auf etwas Existierendes', async () => {
    const registriert = new Set(alleAktionen().map(([name]) => name))
    for (const s of await aktiveSchritte()) {
      const wo = `${s.prozess}/${s.code}`
      if (s.art === 'aktion') {
        assert.ok(s.aktion, `${wo}: Aktionsschritt ohne Aktion`)
        assert.ok(registriert.has(s.aktion!), `${wo}: Aktion „${s.aktion}" ist nicht registriert`)
      }
      if (s.art === 'dienst') {
        assert.ok(s.job_kind, `${wo}: Dienstschritt ohne Job`)
        assert.ok(s.job_kind! in JOB_KATALOG, `${wo}: Job „${s.job_kind}" fehlt im Katalog`)
      }
      if (s.art === 'ereignis') {
        assert.ok(s.ereignis, `${wo}: Ereignisschritt ohne Topic`)
        assert.ok(s.ereignis! in EREIGNISSE, `${wo}: Ereignis „${s.ereignis}" fehlt im Katalog`)
      }
      for (const rolle of s.rollen ?? []) {
        assert.ok(
          (ALL_ROLES as string[]).includes(rolle),
          `${wo}: unbekannte Rolle „${rolle}"`,
        )
      }
    }
  })

  test('jeder Statuswert der Belegmaschine ist abgebildet (oder ausdrücklich nicht)', async () => {
    const prozesse = await h.sql<
      { code: string; modell: string; tabelle: string; status_spalte: string }[]
    >`
      select p.code, p.modell, m.tabelle, m.status_spalte
      from prozesse p join prozess_modelle m on m.modell = p.modell
      where p.aktiv and p.modell is not null`

    for (const p of prozesse) {
      // Der Statusspaltentyp — nur Enums haben eine endliche Wertemenge.
      const werte = await h.sql<{ wert: string }[]>`
        select e.enumlabel as wert
        from pg_attribute a
        join pg_type t on t.oid = a.atttypid and t.typtype = 'e'
        join pg_enum e on e.enumtypid = t.oid
        where a.attrelid = ${p.tabelle}::regclass and a.attname = ${p.status_spalte}
        order by e.enumsortorder`
      if (werte.length === 0) continue

      const zustaende = new Set(
        (await aktiveSchritte())
          .filter((s) => s.prozess === p.code && s.zustand)
          .map((s) => s.zustand!),
      )
      const fehlend = werte
        .map((w) => w.wert)
        .filter((w) => !zustaende.has(w) && !(UNABGEBILDET[p.code] ?? []).includes(w))
      assert.deepEqual(
        fehlend,
        [],
        `${p.code}: Statuswerte ohne Schritt (abbilden oder in UNABGEBILDET aufnehmen): ${fehlend.join(', ')}`,
      )
    }
  })
})

describe('Vollständigkeit: Fixtures', () => {
  test('jeder aktive Prozess hat eine Fixture, jede Fixture einen echten Prozess', async () => {
    const aktive = (await h.sql<{ code: string }[]>`select code from prozesse where aktiv`).map(
      (p) => p.code,
    )
    const abgedeckt = alleFixtures()
      .map(([, f]) => f.prozess)
      .filter((p): p is string => Boolean(p))

    const ohneFixture = aktive.filter((code) => !abgedeckt.includes(code))
    assert.deepEqual(
      ohneFixture,
      [],
      `Aktive Prozesse ohne Fixture (src/modules/prozesse/fixtures/): ${ohneFixture.join(', ')}`,
    )
    const ohneProzess = abgedeckt.filter((code) => !aktive.includes(code))
    assert.deepEqual(ohneProzess, [], `Fixtures für nicht aktive Prozesse: ${ohneProzess.join(', ')}`)
  })

  test('jeder Fixture-Pfad besteht aus existierenden Aktionsschritten', async () => {
    const schritte = await aktiveSchritte()
    for (const [name, fixture] of alleFixtures()) {
      if (!fixture.prozess) continue
      assert.ok(fixture.laeufe?.length, `Fixture „${name}" hat keine Läufe`)
      const codes = new Map(
        schritte.filter((s) => s.prozess === fixture.prozess).map((s) => [s.code, s]),
      )
      for (const lauf of fixture.laeufe!) {
        for (const code of lauf.pfad) {
          const schritt = codes.get(code)
          assert.ok(schritt, `${name}/${lauf.name}: Schritt „${code}" existiert nicht`)
          // Erlaubt im Pfad: Aktionen, Dienste (Outbox), Ereignisse (mit
          // Auslöser aus der Fixture) und 'ende' (schließt Assistenten ab).
          assert.ok(
            ['aktion', 'dienst', 'ereignis', 'ende'].includes(schritt!.art),
            `${name}/${lauf.name}: „${code}" (${schritt!.art}) ist im Pfad nicht ausführbar`,
          )
          if (schritt!.art === 'ereignis') {
            assert.ok(
              lauf.ereignisse?.[code],
              `${name}/${lauf.name}: Ereignisschritt „${code}" braucht einen Auslöser (lauf.ereignisse)`,
            )
          }
        }
        for (const key of Object.keys(lauf.eingaben ?? {})) {
          assert.ok(
            lauf.pfad.includes(key),
            `${name}/${lauf.name}: Eingabe für „${key}", aber der Schritt steht nicht im Pfad`,
          )
        }
      }
    }
  })
})
