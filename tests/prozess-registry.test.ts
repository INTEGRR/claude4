/**
 * Die Aktions-Registry: Konsistenz des Katalogs (DB-frei) plus die statische
 * Abdeckungsanalyse — welcher Alt-Bestand an Server Actions läuft schon über
 * die Registry, und die Ausnahmenliste darf nur schrumpfen.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY, alleAktionen } from '../src/modules/prozesse/registry/index.ts'
import { aktionsFelder, repository } from '../src/modules/prozesse/introspektion.ts'
import { AktionsFehler, RechteFehler, aktionErlaubt, aktionPruefen } from '../src/modules/prozesse/torwaechter.ts'
import { ALL_ROLES, canWrite } from '../src/modules/auth/permissions.ts'
import { JOB_KATALOG } from '../src/modules/prozesse/jobs-katalog.ts'

describe('Aktions-Registry: Katalog', () => {
  test('jeder Eintrag ist vollständig und konsistent benannt', () => {
    // Modellbezogene Namensräume, die bewusst NICHT nach ihrem Bereich heißen:
    // Vorgänge sind bereichsübergreifend gedacht (der Bereich regelt nur die
    // Rechte, das Muster-Paket hängt sie an den Verkauf).
    const NAMENSRAUM_AUSNAHMEN: Record<string, string> = { vorgang: 'verkauf' }

    for (const [name, a] of alleAktionen()) {
      assert.match(name, /^[a-z]+\.[a-z_]+$/, `${name}: Namensschema <bereich>.<verb_objekt>`)
      const praefix = name.split('.')[0]
      assert.ok(
        name.startsWith(`${a.bereich}.`) || NAMENSRAUM_AUSNAHMEN[praefix] === a.bereich,
        `${name}: Präfix muss dem Bereich entsprechen`,
      )
      // Der Bereich selbst ist über den TS-Typ Area abgesichert; zur Laufzeit
      // genügt: der Admin muss ihn kennen (er darf überall schreiben).
      assert.equal(canWrite('admin', a.bereich), true, `${name}: unbekannter Bereich ${a.bereich}`)
      assert.ok(a.label && a.beschreibung, `${name}: Label und Beschreibung sind Pflicht`)
      if (a.uebergang) {
        assert.ok(a.uebergang.nach.length > 0, `${name}: Übergang ohne Zielzustand`)
      }
      // Beleggebundene Aktionen brauchen ein Modell, sobald sie einen
      // Statusübergang behaupten — sonst kann ihn niemand prüfen.
      if (a.uebergang && a.bindung === 'beleg') {
        assert.ok(a.modell, `${name}: Übergang ohne Modell ist nicht prüfbar`)
      }
    }
  })

  test('jede Aktion liefert eine Feldliste (Introspektion trägt)', () => {
    for (const [name, a] of alleAktionen()) {
      // Wirft nicht und liefert für Objektschemas die Feldnamen.
      const felder = aktionsFelder(a)
      assert.ok(Array.isArray(felder), name)
    }
    const repo = repository()
    assert.equal(repo.aktionen.length, Object.keys(REGISTRY).length)
    assert.ok(repo.jobs.length >= 9)
  })

  test('der Admin darf jede Aktion, andere Rollen nur ihren Bereich', () => {
    for (const [name, a] of alleAktionen()) {
      assert.equal(aktionErlaubt(a, 'admin'), true, `${name}: Admin muss dürfen`)
      for (const rolle of ALL_ROLES) {
        const erwartet = a.nurAdmin ? rolle === 'admin' : canWrite(rolle, a.bereich)
        assert.equal(aktionErlaubt(a, rolle), erwartet, `${name} / ${rolle}`)
      }
    }
  })
})

describe('Torwächter: Prüfung ohne Ausführung', () => {
  test('unbekannte Aktionen nennen die erlaubten', () => {
    assert.throws(() => aktionPruefen('gibtsnicht', {}), AktionsFehler)
    assert.throws(() => aktionPruefen('gibtsnicht', {}), /Registriert sind/)
  })

  test('beleggebundene Aktionen verlangen eine gültige Datensatz-ID', () => {
    assert.throws(
      () => aktionPruefen('lager.transfer_stornieren', {}),
      /braucht die ID/,
    )
    assert.throws(
      () => aktionPruefen('lager.transfer_stornieren', { recordId: 'keine-uuid' }),
      /braucht die ID/,
    )
    const ok = aktionPruefen('lager.transfer_stornieren', {
      recordId: '11111111-2222-4333-8444-555555555555',
    })
    assert.equal(ok.aktion.bereich, 'lager')
  })

  test('Schemafehler kommen als verständliche Meldung', () => {
    assert.throws(
      () => aktionPruefen('fehler.ticket_melden', { parameter: { titel: '' } }),
      /titel/,
    )
  })

  test("'werkstatt' ist als Prozess-Code reserviert (Routen-Kollision)", () => {
    // /prozesse/werkstatt ist ein statisches Segment und gewinnt gegen
    // /prozesse/[code] — ein Prozess dieses Namens wäre unerreichbar.
    assert.throws(
      () =>
        aktionPruefen('einstellungen.prozess_entwerfen', {
          parameter: {
            code: 'werkstatt',
            name: 'Kollision',
            bereich: 'lager',
            schritte: [
              { code: 'start', name: 'Start', art: 'start' },
              { code: 'ende', name: 'Ende', art: 'ende' },
            ],
            uebergaenge: [{ von: 'start', nach: 'ende' }],
          },
        }),
      /reserviert/,
    )
  })

  test('FormData läuft durch den Adapter der Aktion', () => {
    const fd = new FormData()
    fd.set('titel', 'Knopf tut nichts')
    fd.set('schwere', 'kritisch')
    fd.set('seite', '/versand')
    const { werte } = aktionPruefen('fehler.ticket_melden', { formData: fd })
    assert.equal(werte.titel, 'Knopf tut nichts')
    assert.equal(werte.schwere, 'kritisch')

    // Der Warenausgangs-Adapter: Mengen, Lose und Backorder-Schalter.
    const buchen = new FormData()
    buchen.set('done_abc', '2')
    buchen.set('lots_abc', 'SN-1, SN-2')
    buchen.set('backorder', 'no')
    const ergebnis = aktionPruefen('lager.transfer_buchen', {
      formData: buchen,
      recordId: '11111111-2222-4333-8444-555555555555',
    })
    assert.deepEqual(ergebnis.werte.mengen, { abc: 2 })
    assert.deepEqual(ergebnis.werte.lose, { abc: 'SN-1, SN-2' })
    assert.equal(ergebnis.werte.backorder, false)
  })

  test('RechteFehler ist vom fachlichen Fehler unterscheidbar (403 vs. 400)', () => {
    assert.ok(new RechteFehler('x') instanceof AktionsFehler)
  })
})

describe('Job-Katalog', () => {
  test('Fähigkeiten sind anbieterneutral benannt', () => {
    for (const [kind, j] of Object.entries(JOB_KATALOG)) {
      assert.match(j.faehigkeit, /^[a-z]+:[a-z_]+$/, kind)
      assert.ok(!j.faehigkeit.includes('shopify') && !j.faehigkeit.includes('dhl'),
        `${kind}: die Fähigkeit benennt den Zweck, nicht den Anbieter`)
    }
  })
})

// --- Statische Abdeckungsanalyse -------------------------------------------

const WURZEL = new URL('../src/app', import.meta.url).pathname

function dateienUnter(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...dateienUnter(voll))
    // ALLE Dateien, nicht nur actions.ts: Server Actions duerfen auch inline
    // in page.tsx oder in *-action.ts stehen — und genau die sind dem
    // Waechter frueher entgangen (er meldete grün, waehrend 26 Actions am
    // Torwaechter vorbeiliefen, 11 davon mit direktem Schreib-SQL).
    else if (/\.tsx?$/.test(eintrag)) treffer.push(voll)
  }
  return treffer
}

/**
 * Modulschlüssel einer Datei, damit Namen eindeutig werden (checkAvailability
 * gibt es in Lager UND Fertigung):
 *   'src/app/(erp)/einkauf/actions.ts'              → 'einkauf'
 *   'src/app/(erp)/einstellungen/page.tsx'          → 'einstellungen'
 *   'src/app/(erp)/produkte/konfiguration/page.tsx' → 'produkte/konfiguration'
 *   'src/app/(erp)/tags-action.ts'                  → 'tags-action'
 */
function modulVon(datei: string): string {
  return datei
    .replace(WURZEL, '')
    .replace(/^\/(\(erp\)\/)?/, '')
    .replace(/\/(actions|page)\.tsx?$/, '')
    .replace(/\.tsx?$/, '')
}

/**
 * Alle Server Actions einer Datei — BEIDE Deklarationsformen:
 *   (a) Datei-weites 'use server' oben + `export async function x`  (actions.ts)
 *   (b) `async function x() { 'use server'; … }`                     (page.tsx)
 * Form (b) war dem Waechter frueher unsichtbar. Genau dort saßen die
 * Umgehungen: 23 Direktiven in fuenf Dateien, davon 21 mit Schreib-SQL.
 */
function serverAktionenIn(inhalt: string): { name: string; koerper: string }[] {
  const kopf = inhalt.slice(0, 400)
  const dateiWeit = /^\s*['"]use server['"]/m.test(kopf)
  const gefunden: { name: string; koerper: string }[] = []
  for (const treffer of inhalt.matchAll(/^(export )?async function (\w+)\s*\(/gm)) {
    const exportiert = Boolean(treffer[1])
    const ab = inhalt.slice(treffer.index!)
    // Rumpf bis zur naechsten Deklaration auf oberster Ebene.
    const rest = ab.slice(1)
    const ende = rest.search(/\n(?:export |async function |function |const |class |\/\*\*)/)
    const koerper = ende > 0 ? ab.slice(0, ende + 1) : ab
    const klammer = koerper.indexOf('{')
    const inlineDirektive =
      klammer >= 0 && /['"]use server['"]/.test(koerper.slice(klammer, klammer + 80))
    // Datei-weites 'use server' macht nur EXPORTIERTE Funktionen zu Actions;
    // private Helfer in derselben Datei sind normale Funktionen.
    if ((dateiWeit && exportiert) || inlineDirektive) {
      gefunden.push({ name: treffer[2], koerper })
    }
  }
  return gefunden
}

/**
 * Noch nicht auf die Registry migrierte Server Actions, geschlüsselt als
 * '<modul>:<name>' (Namen allein sind mehrdeutig — checkAvailability gibt es
 * in Lager UND Fertigung). Die Liste darf nur SCHRUMPFEN: Wandert eine Action
 * auf serverAktion() um, muss ihr Eintrag hier raus — sonst schlägt der
 * Gegen-Check an und die Liste verrottet.
 */
const NOCH_NICHT_MIGRIERT = new Set<string>([
  // LEER — alle actions.ts-Module sind auf die Registry migriert. Neue
  // Server Actions müssen serverAktion() nutzen (oder als Rahmenaktion in
  // RAHMEN_AKTIONEN stehen); diese Liste bleibt nur für künftige Übergänge.
])

/**
 * UI-UMGEHUNGEN — Server Actions, die (noch) NICHT ueber den Torwaechter
 * laufen: kein log_event, kein Nutzungszaehler, nicht ueber /api/aktion
 * erreichbar, nicht im Prozesstest durchspielbar. Das widerspricht der Regel
 * aus AGENTS.md („ausgefuehrt NUR ueber den Torwaechter") und ist damit
 * bewusste, sichtbare Schuld — kein Freibrief.
 *
 * Sie sind nicht ungeschuetzt: jede prueft requireAdmin()/requireWrite().
 * Aber sie fehlen in Protokoll und Prozessbild.
 *
 * Diese Liste darf nur SCHRUMPFEN. Wandert eine Action auf serverAktion() um,
 * muss ihr Eintrag hier raus — sonst schlaegt der Gegen-Check an. Sie wuchs
 * frueher unbemerkt, weil der Waechter nur Dateien namens actions.ts las.
 */
const UI_UMGEHUNGEN = new Set<string>([
  // Einstellungen: schreiben settings-Schluessel bzw. raeumen Daten ab
  'einstellungen:saveDhl',
  'einstellungen:savePolicies',
  'einstellungen:saveFreigaben',
  'einstellungen:saveFinanzen',
  // Stammdaten-Schnellanlage aus der Konfigurationsseite
  'produkte/konfiguration:createCategory',
  'produkte/konfiguration:createTax',
  'produkte/konfiguration:createPaymentTerm',
  'produkte/konfiguration:deleteTag',
  // Integrationen: Outbox/Webhooks/Abgleich anstossen, Ersteinrichtung, Retry
  'integrationen:runJobs',
  'integrationen:processWebhooks',
  'integrationen:runReconcile',
  'integrationen:starteUebernahme',
  'integrationen:starteProduktUebernahme',
  'integrationen:registriereWebhooks',
  'integrationen:pushInventarJetzt',
  'integrationen:retry',
  'integrationen:retryWebhook',
  'integrationen:resetRunning',
  'integrationen/import:uebernehmen',
  'integrationen/import:alleUebernehmen',
  // Querschnitt: Kommentare und Tags an beliebigen Belegen. Beide haben eine
  // EIGENE Modell-Allowlist statt der Registry — bewusstes Muster, aber
  // dadurch ohne Prozessbindung und ohne Nutzungszaehler.
  'comments-action:addComment',
  'tags-action:setTags',
])

/**
 * Rahmenaktionen ohne Registry-Gegenstück — bewusst DAUERHAFT, kein
 * Migrationsrest: sie schalten die Prozessinstanz-Maschine selbst
 * (Assistent starten/abschließen) bzw. die Sammel-Maschine des Sprachmodus
 * (Vorgänge verwerfen/korrigieren/Bulk-buchen — die FACHAKTIONEN darin
 * laufen über aktionAusfuehrenGeprueft, also durch den Torwächter).
 * Geschlossene Liste wie UI_UMGEHUNGEN.
 */
const RAHMEN_AKTIONEN = new Set([
  'p:instanzStarten',
  'p:instanzAbschliessen',
  'sprechen:vorgangVerwerfen',
  'sprechen:zaehlmengeAendern',
  'sprechen:sammlungBuchen',
  // Anmeldung/Abmeldung: Rahmen der Sitzung, keine Fachaktion an einem Beleg.
  'login:signIn',
  'layout:signOut',
])

describe('Registry-Abdeckung (statisch)', () => {
  const dateien = dateienUnter(WURZEL)

  test('jede Server Action nutzt serverAktion() oder steht auf der Restliste', () => {
    const verstoesse: string[] = []
    for (const datei of dateien) {
      const inhalt = readFileSync(datei, 'utf8')
      if (!inhalt.includes("'use server'")) continue
      for (const { name, koerper } of serverAktionenIn(inhalt)) {
        const schluessel = `${modulVon(datei)}:${name}`
        if (NOCH_NICHT_MIGRIERT.has(schluessel) || RAHMEN_AKTIONEN.has(schluessel)) continue
        if (UI_UMGEHUNGEN.has(schluessel)) continue
        // Migriert heißt: der Funktionsrumpf ruft serverAktion(…).
        if (!koerper.includes('serverAktion(')) {
          verstoesse.push(schluessel)
        }
      }
    }
    assert.deepEqual(verstoesse, [], `Nicht registriert und nicht auf der Restliste:\n${verstoesse.join('\n')}`)
  })

  test('die Restliste verrottet nicht: migrierte Actions müssen raus', () => {
    const nochDa = new Set<string>()
    const offen = new Set([...NOCH_NICHT_MIGRIERT, ...UI_UMGEHUNGEN])
    for (const datei of dateien) {
      const inhalt = readFileSync(datei, 'utf8')
      for (const { name, koerper } of serverAktionenIn(inhalt)) {
        const schluessel = `${modulVon(datei)}:${name}`
        if (!offen.has(schluessel)) continue
        if (koerper.includes('serverAktion(')) {
          nochDa.add(`${schluessel} ist migriert — bitte von der Liste streichen`)
        }
      }
    }
    assert.deepEqual([...nochDa], [])
  })

  test('jeder serverAktion-Aufruf zeigt auf eine registrierte Aktion', () => {
    const unbekannt: string[] = []
    for (const datei of dateien) {
      const inhalt = readFileSync(datei, 'utf8')
      for (const treffer of inhalt.matchAll(/serverAktion\('([^']+)'/g)) {
        if (!(treffer[1] in REGISTRY)) unbekannt.push(`${datei}: ${treffer[1]}`)
      }
    }
    assert.deepEqual(unbekannt, [])
  })
})
