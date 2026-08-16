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
    for (const [name, a] of alleAktionen()) {
      assert.match(name, /^[a-z]+\.[a-z_]+$/, `${name}: Namensschema <bereich>.<verb_objekt>`)
      assert.ok(name.startsWith(`${a.bereich}.`), `${name}: Präfix muss dem Bereich entsprechen`)
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
    else if (/actions\.ts$/.test(eintrag)) treffer.push(voll)
  }
  return treffer
}

/** Modulschlüssel einer actions.ts: 'src/app/(erp)/einkauf/actions.ts' → 'einkauf'. */
function modulVon(datei: string): string {
  return datei
    .replace(WURZEL, '')
    .replace(/^\/(\(erp\)\/)?/, '')
    .replace(/\/actions\.ts$/, '')
}

/**
 * Noch nicht auf die Registry migrierte Server Actions, geschlüsselt als
 * '<modul>:<name>' (Namen allein sind mehrdeutig — checkAvailability gibt es
 * in Lager UND Fertigung). Die Liste darf nur SCHRUMPFEN: Wandert eine Action
 * auf serverAktion() um, muss ihr Eintrag hier raus — sonst schlägt der
 * Gegen-Check an und die Liste verrottet.
 */
const NOCH_NICHT_MIGRIERT = new Set([
  'auswertungen:refreshAnalytics',
  ...['createUser', 'setRole', 'setActive', 'resetPassword'].map((n) => `einstellungen/benutzer:${n}`),
  ...['updatePartner', 'createChildContact'].map((n) => `kontakte:${n}`),
  ...['createEmployee', 'updateEmployee', 'clockToggle', 'clockByBarcode', 'stopEntry',
    'addTimeEntry', 'deleteTimeEntry', 'createShift', 'deleteShift', 'requestAbsence',
    'decideAbsence'].map((n) => `personal:${n}`),
  ...['createProduct', 'updateProduct', 'addAttribute', 'setVariantCodes', 'createAttribute',
    'produktZuShopify'].map((n) => `produkte:${n}`),
])

/**
 * Rahmenaktionen ohne Registry-Gegenstück — bewusst DAUERHAFT, kein
 * Migrationsrest: sie schalten die Prozessinstanz-Maschine selbst
 * (Assistent starten/abschließen), dahinter steht keine Fachaktion.
 * Geschlossene Liste wie die fünf UI-Umgehungen.
 */
const RAHMEN_AKTIONEN = new Set(['p:instanzStarten', 'p:instanzAbschliessen'])

describe('Registry-Abdeckung (statisch)', () => {
  const dateien = dateienUnter(WURZEL)

  test('jede Server Action nutzt serverAktion() oder steht auf der Restliste', () => {
    const verstoesse: string[] = []
    for (const datei of dateien) {
      const inhalt = readFileSync(datei, 'utf8')
      if (!inhalt.includes("'use server'")) continue
      for (const treffer of inhalt.matchAll(/export async function (\w+)/g)) {
        const schluessel = `${modulVon(datei)}:${treffer[1]}`
        if (NOCH_NICHT_MIGRIERT.has(schluessel) || RAHMEN_AKTIONEN.has(schluessel)) continue
        // Migriert heißt: der Funktionsrumpf ruft serverAktion(…).
        const rumpf = inhalt.slice(treffer.index)
        const ende = rumpf.indexOf('\nexport ', 1)
        const koerper = ende > 0 ? rumpf.slice(0, ende) : rumpf
        if (!koerper.includes('serverAktion(')) {
          verstoesse.push(schluessel)
        }
      }
    }
    assert.deepEqual(verstoesse, [], `Nicht registriert und nicht auf der Restliste:\n${verstoesse.join('\n')}`)
  })

  test('die Restliste verrottet nicht: migrierte Actions müssen raus', () => {
    const nochDa = new Set<string>()
    for (const datei of dateien) {
      const inhalt = readFileSync(datei, 'utf8')
      for (const treffer of inhalt.matchAll(/export async function (\w+)/g)) {
        const schluessel = `${modulVon(datei)}:${treffer[1]}`
        if (!NOCH_NICHT_MIGRIERT.has(schluessel)) continue
        const rumpf = inhalt.slice(treffer.index)
        const ende = rumpf.indexOf('\nexport ', 1)
        const koerper = ende > 0 ? rumpf.slice(0, ende) : rumpf
        if (koerper.includes('serverAktion(')) {
          nochDa.add(`${schluessel} ist migriert — bitte von der Restliste streichen`)
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
