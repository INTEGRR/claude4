/**
 * Der Interpreter: spielt einen Fixture-Lauf gegen die AKTIVE Prozessversion
 * aus der Datenbank durch — Knöpfe drückt hier niemand, jeder Schritt ist ein
 * Aktionsaufruf über den Torwächter (denselben Weg, den Server Actions und
 * /api/aktion nehmen).
 *
 * Nach jedem Schritt wird geprüft:
 *  - der Schritt wurde vom Prozess tatsächlich ANGEBOTEN (prozess_naechste_schritte),
 *  - die Schritt-Rollen lassen den Test-Nutzer zu (das Panel blendet sonst aus),
 *  - der Beleg steht danach am erwarteten Ort (zustand) bzw. unverändert,
 *  - die Ledger-Invariante hält (Bestand = Summe der Bewegungen).
 */
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import type {
  FixtureKontext,
  ProzessFixture,
  ProzessLauf,
} from '../../src/modules/prozesse/fixtures/typen.ts'
import { assertLedgerConsistent } from '../helpers.ts'

interface Schritt {
  code: string
  art: string
  aktion: string | null
  zustand: string | null
  params: Record<string, unknown> | null
  rollen: string[] | null
}

/** Schritt aus der aktiven Version lesen (für Start-Schritte und zustand). */
async function schrittAusDefinition(
  sql: Sql,
  prozess: string,
  code: string,
): Promise<Schritt | undefined> {
  const [schritt] = await sql<Schritt[]>`
    select s.code, s.art::text as art, s.aktion, s.zustand, s.params, s.rollen
    from prozess_schritte s
    where s.version_id = prozess_aktive_version(${prozess}) and s.code = ${code}`
  return schritt
}

async function standort(sql: Sql, prozess: string, recordId: string): Promise<string | null> {
  const [zeile] = await sql<{ code: string | null }[]>`
    select prozess_aktueller_schritt(${prozess}, ${recordId}) as code`
  return zeile.code
}

export async function prozessDurchspielen(
  sql: Sql,
  fixture: ProzessFixture,
  lauf: ProzessLauf,
  ctx: FixtureKontext,
): Promise<string> {
  const prozess = fixture.prozess
  assert.ok(prozess, 'Daten-Fixtures ohne Prozess haben keine Läufe')
  const nutzer = lauf.nutzer ?? { name: 'prozesstest', role: 'admin' as const }
  let recordId: string | undefined

  for (const code of lauf.pfad) {
    let schritt: Schritt
    if (!recordId) {
      // Noch kein Beleg: der erste Schritt muss direkt am Startknoten hängen.
      const definiert = await schrittAusDefinition(sql, prozess, code)
      assert.ok(definiert, `${prozess}: Schritt „${code}" existiert nicht in der aktiven Version`)
      const [amStart] = await sql<{ ok: boolean }[]>`
        select exists(
          select 1 from prozess_uebergaenge u
          where u.version_id = prozess_aktive_version(${prozess})
            and u.von_code = 'start' and u.nach_code = ${code}
        ) as ok`
      assert.ok(amStart.ok, `${prozess}: „${code}" hängt nicht am Start`)
      schritt = definiert
    } else {
      const naechste = await sql<Schritt[]>`
        select code, art::text as art, aktion, rollen, params, null as zustand
        from prozess_naechste_schritte(${prozess}, ${recordId})`
      const angeboten = naechste.find((n) => n.code === code)
      assert.ok(
        angeboten,
        `${prozess}: „${code}" wird nicht angeboten ` +
          `(möglich: ${naechste.map((n) => n.code).join(', ') || '—'})`,
      )
      // zustand liefert die Funktion nicht mit — aus der Definition ergänzen.
      const definiert = await schrittAusDefinition(sql, prozess, code)
      schritt = { ...angeboten, zustand: definiert?.zustand ?? null }
    }

    assert.equal(schritt.art, 'aktion', `${prozess}/${code}: Läufe führen nur Aktionsschritte aus`)
    assert.ok(schritt.aktion, `${prozess}/${code}: Aktionsschritt ohne Aktion`)
    if (schritt.rollen?.length) {
      assert.ok(
        schritt.rollen.includes(nutzer.role),
        `${prozess}/${code}: Rolle ${nutzer.role} ist am Schritt nicht zugelassen (${schritt.rollen.join(', ')})`,
      )
    }

    const eingabe = lauf.eingaben?.[code]
    const werte = typeof eingabe === 'function' ? eingabe(ctx) : (eingabe ?? {})
    // Die Prozessdefinition legt vor (params), der Lauf ergänzt/übersteuert.
    const parameter = { ...(schritt.params ?? {}), ...werte }

    // Explizit typisiert: die Schleifen-Flussanalyse um das asserted
    // `recordId` macht die Inferenz hier sonst zirkulär (TS7022).
    const vorher: string | null = recordId ? await standort(sql, prozess, recordId) : null
    const ergebnis = await aktionAusfuehrenGeprueft(
      schritt.aktion,
      { parameter, recordId },
      nutzer,
    )

    if (!recordId) {
      recordId = (ergebnis ?? {}).recordId
      assert.ok(recordId, `${prozess}/${code}: der Anlage-Schritt muss eine recordId liefern`)
    }

    if (schritt.zustand) {
      assert.equal(
        await standort(sql, prozess, recordId),
        code,
        `${prozess}: nach „${code}" müsste der Beleg dort stehen`,
      )
    } else if (vorher !== null) {
      assert.equal(
        await standort(sql, prozess, recordId),
        vorher,
        `${prozess}/${code}: ein Schritt ohne zustand darf den Standort nicht ändern`,
      )
    }

    await assertLedgerConsistent(sql)
  }

  assert.ok(recordId, `${prozess}: der Lauf „${lauf.name}" hat keinen Beleg erzeugt`)

  if (lauf.danachKeineSchritte) {
    const uebrig = await sql<{ code: string }[]>`
      select code from prozess_naechste_schritte(${prozess}, ${recordId})`
    assert.equal(
      uebrig.length,
      0,
      `${prozess}: am Ende von „${lauf.name}" bietet der Prozess noch an: ${uebrig.map((u) => u.code).join(', ')}`,
    )
  }

  await lauf.pruefen?.(sql, ctx, recordId)
  return recordId
}
