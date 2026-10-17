import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { LABELS, type LabelArt, label, tone } from '../src/modules/shared/format.ts'
import { closeDb, db } from './helpers.ts'

/**
 * Zustandstabelle (F1, Entscheidungslog 2026-10-17): `LABELS` in
 * src/modules/shared/format.ts ist die einzige Quelle für die Beschriftung
 * von Statuswerten.
 *  (a) Jeder Wert jedes Status-Enums der Datenbank hat ein Label — ein neuer
 *      Enum-Wert ohne Beschriftung erschiene sonst roh („stoerend").
 *  (b) Keine lokalen Status-Maps mit eigenen Texten in Seiten/Modulen —
 *      geschlossene, begründete Ausnahmeliste, die nur schrumpfen soll.
 */

after(closeDb)

/** Status-Enum der Datenbank → Belegart der Zustandstabelle. */
const ENUM_ART: Record<string, LabelArt> = {
  absence_state: 'absence',
  absence_kind: 'absence_art',
  aufgabe_status: 'aufgabe',
  bemusterung_status: 'bemusterung',
  bill_state: 'bill',
  billing_status: 'billing',
  bug_schwere: 'ticket_schwere',
  bug_status: 'ticket',
  delivery_status: 'delivery',
  eingangs_sendung_status: 'eingangs_sendung',
  einkaufsprojekt_status: 'einkaufsprojekt',
  employment_type: 'beschaeftigung',
  invoice_status: 'invoice',
  job_status: 'job',
  ki_vorschlag_status: 'ki_vorschlag',
  kundenrechnung_status: 'kundenrechnung',
  lieferantenvertrag_status: 'lieferantenvertrag',
  mail_entwurf_status: 'mail_entwurf',
  mail_thread_status: 'mail_thread',
  mo_operation_state: 'mo_operation',
  mo_state: 'mo',
  move_state: 'move',
  picking_state: 'picking',
  purchase_state: 'purchase',
  repair_state: 'repair',
  retoure_status: 'retoure',
  sale_state: 'sale',
  shift_state: 'shift',
  shipment_state: 'shipment',
  webhook_status: 'webhook',
  werkzeug_status: 'werkzeug',
}

/** Enums mit Endung _state/_status, die bewusst keine Zustände von Belegen sind. */
const KEIN_ZUSTAND = new Map<string, string>([])

describe('Zustandstabelle', () => {
  test('(a) jeder Wert jedes Status-Enums hat ein Label', async () => {
    const enums = await db()<{ typ: string; werte: string[] }[]>`
      select t.typname as typ, array_agg(e.enumlabel order by e.enumsortorder) as werte
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      group by t.typname`
    const ohneArt = enums
      .map((e) => e.typ)
      .filter((t) => /_(state|status)$/.test(t) && !(t in ENUM_ART) && !KEIN_ZUSTAND.has(t))
    assert.deepEqual(ohneArt, [], `Status-Enum ohne Belegart in ENUM_ART: ${ohneArt.join(', ')}`)

    const fehlen: string[] = []
    for (const e of enums) {
      const art = ENUM_ART[e.typ]
      if (!art) continue
      const labels = LABELS[art] as Record<string, string>
      for (const w of e.werte) if (!labels[w]) fehlen.push(`${e.typ}.${w} (LABELS.${art})`)
    }
    assert.deepEqual(fehlen, [], `ohne Label:\n${fehlen.join('\n')}`)
  })

  test('cancel heißt bei Belegen „Storniert"; tone kennt die Belegart', () => {
    for (const art of ['sale', 'purchase', 'picking', 'mo', 'repair', 'bill'] as const) {
      assert.equal(label(art, 'cancel'), 'Storniert', art)
    }
    assert.equal(tone('genehmigt', 'retoure'), 'info', 'Retoure genehmigt ist ein Zwischenschritt')
    assert.equal(tone('approved', 'absence'), 'success')
    assert.equal(label('ticket_schwere', 'stoerend'), 'Störend')
  })

  test('(b) keine lokalen Status-Maps mit eigenen Texten', () => {
    const SRC = new URL('../src', import.meta.url).pathname
    /** Geschlossene Liste — Datei → Begründung. Neue Einträge nur mit gutem Grund. */
    const AUSNAHMEN = new Map([
      ['modules/prozesse/registry/einkauf-bemusterung-ausfuehren.ts', 'Satzform in Fehlermeldungen („ist schon zum Nachbessern zurück")'],
      ['modules/prozesse/registry/einkauf-projekte-ausfuehren.ts', 'Satzform in Fehlermeldungen („ist im Bedarf")'],
      ['modules/versand/track17-logik.ts', 'Abbildung und Texte externer 17TRACK-Codes, keine eigenen Zustände'],
      ['modules/einkauf/bemusterung.ts', 'Logik: Prüfergebnis → Status, keine Beschriftung'],
      ['components/nutze-gespraech.tsx', 'Zustände des Sprachdialogs im Browser, keine Belegzustände'],
      ['app/(erp)/einstellungen/benachrichtigungen/page.tsx', 'LED-Ton für <Zustand>, Beschriftung aus LABELS'],
      ['app/(erp)/sprechen/pruefung.tsx', 'LED-Klassen für Prüfvorgänge, keine Beschriftung'],
      ['app/(erp)/integrationen/import/page.tsx', 'Filterdefinition (Abfrage + Knopftext), keine Statusbeschriftung'],
    ])
    const dateien = (pfad: string): string[] =>
      readdirSync(pfad).flatMap((e) => {
        const voll = join(pfad, e)
        return statSync(voll).isDirectory() ? dateien(voll) : /\.tsx?$/.test(e) ? [voll] : []
      })
    const muster = /const\s+[A-Z_]*(STATUS|SCHWERE|ZUSTAND|STATE|ABSENCE|EMPLOYMENT|PRUEFUNG)[A-Z_]*\s*(?::[^=]+)?=\s*\{([^}]*)\}/g
    const treffer: string[] = []
    for (const datei of dateien(SRC)) {
      const rel = relative(SRC, datei)
      if (rel === 'modules/shared/format.ts' || AUSNAHMEN.has(rel)) continue
      const text = readFileSync(datei, 'utf8')
      for (const m of text.matchAll(muster)) {
        if (/\w+\s*:\s*'[^']*'/.test(m[2])) treffer.push(`${rel}: ${m[0].split('=')[0].trim()}`)
      }
    }
    assert.deepEqual(treffer, [], `lokale Status-Maps — Beschriftung gehört in LABELS (format.ts):\n${treffer.join('\n')}`)
    for (const rel of AUSNAHMEN.keys()) {
      assert.ok(statSync(join(SRC, rel), { throwIfNoEntry: false }), `Ausnahme ${rel} existiert nicht mehr — streichen`)
    }
  })
})
