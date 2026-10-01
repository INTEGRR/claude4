import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  AGENT_VORSCHLAG_AKTIONEN,
  EINKAUF_AGENT_WERKZEUGE,
  SCHREIBENDE_WERKZEUGE,
  WERKZEUG_NAMEN,
  fakeTriageZug,
  type TriageKontext,
} from '../src/modules/ki/einkauf-prompt.ts'
import { registrierteAktion } from '../src/modules/prozesse/registry/index.ts'

/**
 * Wächter des Einkaufs-Agenten (Plan Stufe 6, Entscheidungslog 2026-10-01):
 * Die Werkzeuge des Agenten können weder senden noch ausführen.
 *
 *  1. Der Werkzeugkatalog ist eine GESCHLOSSENE Liste — ein neues Werkzeug
 *     macht die Suite rot und braucht eine bewusste Entscheidung hier.
 *  2. Die schreibenden Werkzeuge kennen weder Empfänger, Thread noch Status.
 *  3. Vorschlagbar sind nur `ki`-Aktionen ohne Statusübergang, nichts, was
 *     sendet, entscheidet oder bestellt; Annehmen ist nie `ki`.
 *  4. Statisch: Die Module des Agenten importieren — auch über Umwege —
 *     weder den Torwächter noch die Ausführung, den Server-Action-Transport,
 *     das Senden über Gmail oder den Job-Runner, und ihr Quelltext ruft
 *     weder aktionAusfuehrenGeprueft noch serverAktion noch enqueue_job.
 */

const WURZEL = resolve(new URL('..', import.meta.url).pathname)
const SRC = join(WURZEL, 'src')

/** Die Module des Agenten — Einstiegspunkte der Import-Analyse. */
const AGENT_MODULE = [
  'src/modules/ki/einkauf-agent.ts',
  'src/modules/ki/einkauf-werkzeuge.ts',
  'src/modules/ki/einkauf-prompt.ts',
  'src/modules/ki/einkauf-ki.ts',
  'src/modules/ki/dokument-lesen.ts',
]

/** Was der Agent nie erreichen darf — direkt oder über ein importiertes Modul. */
const VERBOTENE_MODULE: { muster: RegExp; grund: string }[] = [
  { muster: /^src\/modules\/prozesse\/torwaechter\.ts$/, grund: 'führt Registry-Aktionen aus' },
  { muster: /^src\/modules\/prozesse\/server-aktion\.ts$/, grund: 'Server-Action-Transport' },
  { muster: /^src\/modules\/prozesse\/ausfuehren\.ts$/, grund: 'Ausführung aller Aktionen' },
  { muster: /-ausfuehren\.ts$/, grund: 'Fachausführung einer Aktion' },
  { muster: /^src\/modules\/einkauf\/mail-senden\.ts$/, grund: 'sendet Mails' },
  { muster: /^src\/modules\/einkauf\/mail-bauen\.ts$/, grund: 'baut Mails zum Senden' },
  { muster: /^src\/modules\/google\/gmail\.ts$/, grund: 'Gmail-API (senden)' },
  { muster: /^src\/modules\/google\/google-fake-gmail\.ts$/, grund: 'Gmail-Attrappe (senden)' },
  { muster: /^src\/modules\/integrationen\/jobs\.ts$/, grund: 'Job-Runner' },
  { muster: /^src\/modules\/integrationen\/mail\.ts$/, grund: 'sendet Mails (Resend)' },
  { muster: /^src\/modules\/integrationen\/shopify\.ts$/, grund: 'schreibt in den Shop' },
  { muster: /^src\/app\//, grund: 'Oberfläche/Server Actions' },
]

/** Was im Quelltext der Agentenmodule nicht vorkommen darf. */
const VERBOTENE_AUFRUFE: RegExp[] = [
  /aktionAusfuehrenGeprueft/,
  /serverAktion/,
  /\bAUSFUEHRUNG\b/,
  /enqueue_job/,
  /gmail_senden/,
  /freigabeEinreihen|entwurfSenden/,
  /status\s*=\s*'(freigegeben|gesendet)'/,
  /insert\s+into\s+integration_jobs/i,
]

/** Imports (keine reinen Typ-Importe) eines Moduls, auf Dateien in src aufgelöst. */
function importe(datei: string): string[] {
  const text = readFileSync(join(WURZEL, datei), 'utf8')
  const ziele: string[] = []
  const muster = [
    /^\s*import\s+(?!type\s)[^;]*?\sfrom\s+'([^']+)'/gm,
    /^\s*import\s+'([^']+)'/gm,
    /^\s*export\s+(?!type\s)[^;]*?\sfrom\s+'([^']+)'/gm,
    /\bimport\(\s*'([^']+)'\s*\)/g,
  ]
  for (const m of muster) for (const t of text.matchAll(m)) ziele.push(t[1])
  const aufgeloest: string[] = []
  for (const ziel of ziele) {
    let basis: string | null = null
    if (ziel.startsWith('@/')) basis = join(SRC, ziel.slice(2))
    else if (ziel.startsWith('.')) basis = resolve(dirname(join(WURZEL, datei)), ziel)
    if (!basis) continue // Paket (node_modules) — kein App-Modul
    const kandidat = [basis, `${basis}.ts`, `${basis}.tsx`, join(basis, 'index.ts')].find(
      (k) => existsSync(k) && /\.tsx?$/.test(k),
    )
    if (kandidat) aufgeloest.push(relative(WURZEL, kandidat))
  }
  return aufgeloest
}

/** Alle erreichbaren App-Module ab den Einstiegspunkten, je mit einem Weg dorthin. */
function erreichbar(start: string[]): Map<string, string[]> {
  const wege = new Map<string, string[]>()
  const offen = start.map((s) => [s])
  while (offen.length) {
    const weg = offen.shift()!
    const datei = weg.at(-1)!
    if (wege.has(datei)) continue
    wege.set(datei, weg)
    for (const ziel of importe(datei)) if (!wege.has(ziel)) offen.push([...weg, ziel])
  }
  return wege
}

describe('Einkaufs-Agent: Werkzeuge können weder senden noch ausführen (Wächter)', () => {
  test('der Werkzeugkatalog ist eine geschlossene Liste', () => {
    assert.deepEqual(
      EINKAUF_AGENT_WERKZEUGE.map((w) => w.name),
      ['sql_abfrage', 'thread_lesen', 'lieferantenakte_lesen', 'projekt_lesen', 'dokument_lesen', 'vorschlag_anlegen', 'entwurf_anlegen'],
      'Neues Werkzeug? Bewusst entscheiden: kann es senden, buchen, freigeben oder ausführen? Dann gehört es nicht in den Agenten.',
    )
    assert.deepEqual([...WERKZEUG_NAMEN], EINKAUF_AGENT_WERKZEUGE.map((w) => w.name))
    assert.deepEqual([...SCHREIBENDE_WERKZEUGE], ['vorschlag_anlegen', 'entwurf_anlegen'])
  })

  test('kein Werkzeugname verspricht Senden, Freigeben, Buchen oder Ausführen', () => {
    for (const w of EINKAUF_AGENT_WERKZEUGE) {
      assert.doesNotMatch(w.name, /send|senden|freigeb|buch|ausf|ausfuehr|aktion|zahl|bestell|job/i, w.name)
    }
  })

  test('die schreibenden Werkzeuge kennen weder Empfänger, Thread noch Status', () => {
    for (const name of SCHREIBENDE_WERKZEUGE) {
      const w = EINKAUF_AGENT_WERKZEUGE.find((x) => x.name === name)!
      const felder = Object.keys((w.input_schema as { properties?: Record<string, unknown> }).properties ?? {})
      for (const verboten of ['an', 'cc', 'bcc', 'empfaenger', 'status', 'quelle', 'thread_id', 'gesendet', 'freigegeben']) {
        assert.ok(!felder.includes(verboten), `${name} darf kein Feld „${verboten}" haben`)
      }
    }
  })

  test('vorschlagbar sind nur ki-Aktionen ohne Statusübergang — nichts, was sendet oder entscheidet', () => {
    assert.deepEqual(Object.keys(AGENT_VORSCHLAG_AKTIONEN).sort(), [
      'einkauf.angebot_erfassen',
      'einkauf.dokument_aendern',
      'einkauf.mail_zuordnen',
      'einkauf.projekt_position_setzen',
      'einkauf.wiedervorlage_anlegen',
    ])
    for (const name of Object.keys(AGENT_VORSCHLAG_AKTIONEN)) {
      const a = registrierteAktion(name)
      assert.ok(a, `${name} ist nicht registriert`)
      assert.equal(a.ki, true, `${name} ist nicht für die KI freigegeben`)
      assert.equal(a.uebergang, undefined, `${name} schaltet einen Status — gehört nicht in die Vorschläge`)
      assert.ok(!a.nurAdmin, `${name} ist eine Verwaltungsaktion`)
    }
    for (const nie of [
      'einkauf.mail_freigeben',
      'einkauf.anfragen_freigeben',
      'einkauf.anfragen_senden',
      'einkauf.mail_entwurf_anlegen',
      'einkauf.email_senden',
      'einkauf.projekt_entscheiden',
      'einkauf.projekt_bestellen',
      'einkauf.bestellung_freigeben',
      'einkauf.bestaetigen',
      'einkauf.rechnung_buchen',
      'einkauf.rechnung_zahlen',
      'einkauf.vorschlag_annehmen',
    ]) {
      assert.ok(!(nie in AGENT_VORSCHLAG_AKTIONEN), `${nie} darf der Agent nie vorschlagen`)
    }
  })

  test('Annehmen, Verwerfen und Ändern sind nie ki — der Agent nimmt nicht selbst an', () => {
    for (const name of ['einkauf.vorschlag_annehmen', 'einkauf.vorschlag_verwerfen', 'einkauf.vorschlag_aendern']) {
      const a = registrierteAktion(name)
      assert.ok(a, name)
      assert.ok(!a.ki, `${name} darf nicht ki sein`)
    }
    assert.ok(!registrierteAktion('einkauf.mail_freigeben')?.ki, 'Freigeben bleibt menschlich')
  })

  test('der Fake ruft nur Werkzeuge aus dem Katalog', () => {
    const k: TriageKontext = {
      heute: '2026-10-01',
      nachricht: {
        id: '11111111-1111-4111-8111-111111111111',
        von: 'amy@pcb.example',
        von_name: 'Amy Li',
        betreff: 'Quotation',
        datum: '2026-10-01 08:00:00+00',
        kanal: 'email',
        sprache: 'en',
        text: 'Price for 1000 pcs is 0.85 USD, MOQ 500. Shipped tomorrow.',
        anhaenge: [],
      },
      thread: {
        id: '22222222-2222-4222-8222-222222222222',
        betreff: 'Quotation',
        status: 'offen',
        zugeordnet_durch: 'regel',
        anzahl: 1,
        partner: { id: '33333333-3333-4333-8333-333333333333', name: 'PCB Ltd', sprache: 'en' },
        bestellung: { id: '44444444-4444-4444-8444-444444444444', number: 'P00001', state: 'purchase' },
        projekt: {
          id: '55555555-5555-4555-8555-555555555555',
          nummer: 'EP/00001',
          titel: 'Platine',
          status: 'angefragt',
          positionen: [{ id: '66666666-6666-4666-8666-666666666666', bezeichnung: 'PCB', menge: 1000, zielpreis_eur: null }],
        },
      },
      offene_vorschlaege: [],
      offene_entwuerfe: 0,
    }
    for (let runde = 0; runde < 5; runde++) {
      for (const aufruf of fakeTriageZug(runde, k) ?? []) {
        assert.ok((WERKZEUG_NAMEN as readonly string[]).includes(aufruf.name), aufruf.name)
      }
    }
  })

  test('statisch: kein Weg vom Agenten zu Torwächter, Ausführung, Senden oder Job-Runner', () => {
    const wege = erreichbar(AGENT_MODULE)
    // Plausibilität: die Analyse sieht wirklich etwas.
    assert.ok(wege.has('src/modules/ki/sql-tool.ts'), 'sql-tool.ts muss erreichbar sein')
    assert.ok(wege.has('src/db/client.ts'), 'db/client.ts muss erreichbar sein')
    const verstoesse: string[] = []
    for (const [datei, weg] of wege) {
      for (const v of VERBOTENE_MODULE) {
        if (v.muster.test(datei)) verstoesse.push(`${datei} (${v.grund}) über ${weg.join(' → ')}`)
      }
    }
    assert.deepEqual(verstoesse, [], `Der Agent erreicht verbotene Module:\n${verstoesse.join('\n')}`)
  })

  test('statisch: der Quelltext des Agenten ruft weder Torwächter noch Transport noch Jobs', () => {
    const verstoesse: string[] = []
    for (const datei of AGENT_MODULE) {
      const zeilen = readFileSync(join(WURZEL, datei), 'utf8').split('\n')
      for (const [i, zeile] of zeilen.entries()) {
        const code = zeile.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        for (const muster of VERBOTENE_AUFRUFE) {
          if (muster.test(code)) verstoesse.push(`${datei}:${i + 1} ${zeile.trim()}`)
        }
      }
    }
    assert.deepEqual(verstoesse, [], `Verbotene Aufrufe im Agenten:\n${verstoesse.join('\n')}`)
  })

  test('statisch: Entwürfe des Agenten entstehen immer als quelle agent, Status entwurf', () => {
    const text = readFileSync(join(WURZEL, 'src/modules/ki/einkauf-werkzeuge.ts'), 'utf8')
    const inserts = [...text.matchAll(/insert\s+into\s+mail_entwuerfe[\s\S]*?returning/gi)].map((m) => m[0])
    assert.equal(inserts.length, 1, 'genau eine Stelle legt Entwürfe an')
    assert.match(inserts[0], /'agent',\s*'entwurf'/, 'quelle und Status sind fest verdrahtet, nicht vom Modell')
    // Keine andere Agentendatei schreibt Entwürfe.
    for (const datei of AGENT_MODULE.filter((d) => !d.endsWith('einkauf-werkzeuge.ts'))) {
      assert.doesNotMatch(readFileSync(join(WURZEL, datei), 'utf8'), /(insert\s+into|update)\s+mail_entwuerfe/i, datei)
    }
  })
})
