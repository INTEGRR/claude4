import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ohneVorgaben, typFehler } from '../src/modules/prozesse/registry/zod-hilfen.ts'
import { REGISTRY } from '../src/modules/prozesse/registry/index.ts'
import { formularFelder } from '../src/modules/prozesse/schema-felder.ts'
import type { RegistrierteAktion } from '../src/modules/prozesse/registry/typen.ts'

/**
 * Umstieg auf zod 4 (Entscheidungslog 2026-11-13): die Stellen, an denen sich
 * das Verhalten gegenüber zod 3 still geändert hätte, sind hier festgenagelt.
 */

const meldung = (s: z.ZodType, wert: unknown) => {
  const r = s.safeParse(wert)
  return r.success ? null : r.error.issues.map((i) => i.message).join('; ')
}

describe('zod 4: Hilfen und festgehaltenes Verhalten', () => {
  test('typFehler: eigene Meldung nur für den Typfehler, Bereichsprüfungen behalten ihre', () => {
    const s = z.number({ error: typFehler('Bitte eine Zahl angeben') }).min(5, 'Mindestens 5').max(10)
    assert.equal(meldung(s, 'abc'), 'Bitte eine Zahl angeben')
    assert.equal(meldung(s, Number.NaN), 'Bitte eine Zahl angeben')
    assert.equal(meldung(s, undefined), 'Bitte eine Zahl angeben')
    assert.equal(meldung(s, 3), 'Mindestens 5')
    assert.notEqual(meldung(s, 11), 'Bitte eine Zahl angeben', 'ohne typFehler gälte die Typ-Meldung auch hier')
    assert.equal(meldung(s, 7), null)
  })

  test('ohneVorgaben: fehlende Felder bleiben weg — auch solche mit Standardwert', () => {
    const felder = { kosten: z.number().default(0), notiz: z.string().optional(), waehrung: z.string().length(3) }
    const s = z.object(ohneVorgaben(felder))
    assert.deepEqual(s.parse({}), {})
    assert.deepEqual(s.parse({ kosten: 5 }), { kosten: 5 })
    // Genau die Falle: .partial() füllt in zod 4 den Standardwert.
    assert.deepEqual(z.object(felder).partial().parse({}), { kosten: 0 })
  })

  test('Angebot ändern: fehlende Kosten werden nicht zu 0', () => {
    const r = REGISTRY['einkauf.angebot_aendern'].schema.parse({ angebot_id: '00000000-0000-0000-0000-000000000001' })
    assert.equal('werkzeugkosten' in r, false)
    assert.equal('musterkosten' in r, false)
  })

  test('IDs: jede 8-4-4-4-12-Kennung gilt weiter (guid statt der strengeren uuid-Prüfung)', () => {
    const s = REGISTRY['einkauf.angebot_aendern'].schema
    assert.equal(s.safeParse({ angebot_id: '00000000-0000-0000-0000-000000000001' }).success, true)
    assert.equal(s.safeParse({ angebot_id: 'keine-id' }).success, false)
  })

  test('Beschreibungen überleben .optional() und .default(); Vorgabe und Pflicht stimmen', () => {
    const aktion = {
      label: 'Test', bereich: 'lager', beschreibung: '', bindung: 'frei',
      schema: z
        .object({
          a: z.string().describe('Feld A').optional(),
          b: z.number().describe('Feld B').default(3),
          c: z.string().max(2000),
          d: z.enum(['x', 'y']).optional().describe('Feld D'),
        })
        .refine(() => true),
    } as unknown as RegistrierteAktion
    const felder = Object.fromEntries(formularFelder(aktion).map((f) => [f.name, f]))
    assert.equal(felder.a.label, 'Feld A')
    assert.equal(felder.a.pflicht, false)
    assert.equal(felder.b.hinweis, 'Feld B')
    assert.equal(felder.b.vorgabe, 3)
    assert.equal(felder.b.typ, 'nummer')
    assert.equal(felder.c.typ, 'mehrzeilig')
    assert.equal(felder.c.pflicht, true)
    assert.deepEqual([felder.d.label, felder.d.typ, felder.d.auswahl], ['Feld D', 'auswahl', ['x', 'y']])
  })

  test('Wächter: keine strenge uuid-Prüfung, kein .partial(), keine zod-3-Parameter im Quelltext', () => {
    const wurzel = new URL('../src', import.meta.url).pathname
    const dateien = (pfad: string): string[] =>
      readdirSync(pfad).flatMap((e) => {
        const voll = join(pfad, e)
        return statSync(voll).isDirectory() ? dateien(voll) : /\.tsx?$/.test(e) ? [voll] : []
      })
    const treffer: string[] = []
    for (const datei of dateien(wurzel)) {
      const text = readFileSync(datei, 'utf8')
      if (!text.includes("from 'zod'") || datei.endsWith('zod-hilfen.ts')) continue
      text.split('\n').forEach((zeile, i) => {
        if (/^\s*(\/\/|\*)/.test(zeile)) return
        if (/\.uuid\(|\.partial\(\)|invalid_type_error|required_error|errorMap:|z\.record\([^,()]*(\(\))?\)/.test(zeile)) {
          treffer.push(`${relative(wurzel, datei)}:${i + 1}: ${zeile.trim()}`)
        }
      })
    }
    assert.deepEqual(treffer, [], `zod-4-Konvention verletzt (siehe registry/zod-hilfen.ts):\n${treffer.join('\n')}`)
  })

  test('Standardmeldungen sind deutsch, sobald die Registry geladen ist', () => {
    assert.match(meldung(z.object({ a: z.string() }), {}) ?? '', /^Ungültige Eingabe/)
  })
})
