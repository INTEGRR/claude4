import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type AuswahlOption, filtern, normalisieren, startwert } from '../src/components/auswahl-logik.ts'

/**
 * Auswahlbox statt <select> (Betreiber 2026-10-02: „Dropdowns müssen eine
 * interaktive Box mit Filter/Suche sein"). Der Wächter hält neue Felder auf
 * <Auswahl> (src/components/auswahl.tsx); die Logik-Tests sichern Suche und
 * die Gleichheit zum nativen <select> beim abgeschickten Wert.
 */

const SRC = new URL('../src', import.meta.url).pathname

/**
 * Geschlossene Liste: öffentliche Formulare für Kunden bleiben nativ — auf
 * dem Telefon ist der System-Auswähler dort besser, und die Listen sind kurz.
 */
const AUSNAHMEN = new Map([
  ['app/service/reparatur/anfrageformular.tsx', 'öffentliches Reparaturformular (auch im Shop eingebettet), Land: wenige Einträge'],
  ['app/start/registrierung.tsx', 'öffentliche Registrierung auf der Startseite, zwei kurze Listen'],
])

function dateien(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...dateien(voll))
    else if (eintrag.endsWith('.tsx')) treffer.push(voll)
  }
  return treffer
}

function opt(text: string, extra: Partial<AuswahlOption> = {}): AuswahlOption {
  return { wert: extra.wert ?? text, text, deaktiviert: false, suche: normalisieren(text), ...extra }
}

describe('Auswahlbox: kein natives <select> im internen Teil (Wächter)', () => {
  test('alle Auswahlfelder nutzen <Auswahl>', () => {
    const funde: string[] = []
    for (const datei of dateien(SRC)) {
      const rel = relative(SRC, datei)
      if (AUSNAHMEN.has(rel)) continue
      readFileSync(datei, 'utf8')
        .split('\n')
        .forEach((zeile, i) => {
          const code = zeile.trim()
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('{/*')) return
          if (/<select\b/.test(code)) funde.push(`src/${rel}:${i + 1}`)
        })
    }
    assert.deepEqual(
      funde,
      [],
      `Natives <select> gefunden — bitte <Auswahl> aus @/components/auswahl nehmen (gleiche Props und Kinder):\n${funde.join('\n')}`,
    )
  })

  test('die Ausnahmen gibt es noch und sie haben wirklich ein <select>', () => {
    for (const rel of AUSNAHMEN.keys()) {
      assert.match(readFileSync(join(SRC, rel), 'utf8'), /<select\b/, `${rel}: Ausnahme ist überflüssig`)
    }
  })
})

describe('Auswahlbox: Suche', () => {
  const produkte = [
    opt('NATIVE 75 Hot Swap PCB (Layout: ANSI) · N75-PCB-ANSI'),
    opt('[RF-001] Rubber Feed Sticker · RF-001'),
    opt('Schraube M2 · SCR-M2'),
    opt('Müller GmbH'),
    opt('Straßenbau Süd'),
  ]

  test('Wörter in beliebiger Reihenfolge, Groß/klein egal', () => {
    const { treffer } = filtern(produkte, 'pcb native')
    assert.deepEqual(treffer.map((o) => o.text), ['NATIVE 75 Hot Swap PCB (Layout: ANSI) · N75-PCB-ANSI'])
  })

  test('ohne Akzente und mit ß → ss', () => {
    assert.equal(filtern(produkte, 'muller').treffer[0]?.text, 'Müller GmbH')
    assert.equal(filtern(produkte, 'strassenbau sud').treffer[0]?.text, 'Straßenbau Süd')
  })

  test('Artikelnummer findet den Artikel', () => {
    assert.equal(filtern(produkte, 'rf-001').treffer.length, 1)
  })

  test('Textanfang vor Wortanfang vor Treffer mittendrin', () => {
    const liste = [opt('Gehäuse Alu schwarz'), opt('Alu-Platte'), opt('Schalter Alu')]
    assert.deepEqual(
      filtern(liste, 'alu').treffer.map((o) => o.text),
      ['Alu-Platte', 'Gehäuse Alu schwarz', 'Schalter Alu'],
    )
  })

  test('data-suche und Gruppe suchen mit', () => {
    const kunde = opt('Max Mustermann', { suche: normalisieren('Max Mustermann max@example.com Berlin Kunden') })
    assert.equal(filtern([kunde], 'berlin').treffer.length, 1)
    assert.equal(filtern([kunde], 'example').treffer.length, 1)
  })

  test('lange Listen: höchstens max Treffer, der Rest wird gezählt', () => {
    const viele = Array.from({ length: 450 }, (_, i) => opt(`Artikel ${i}`))
    const { treffer, mehr } = filtern(viele, '', 200)
    assert.equal(treffer.length, 200)
    assert.equal(mehr, 250)
    assert.equal(filtern(viele, 'artikel 44').treffer[0].text, 'Artikel 44')
  })

  test('kein Treffer → leere Liste', () => {
    assert.deepEqual(filtern(produkte, 'gibtsnicht'), { treffer: [], mehr: 0 })
  })
})

describe('Auswahlbox: abgeschickter Wert wie beim nativen <select>', () => {
  const mitPlatzhalter = [opt('— auswählen —', { wert: '', deaktiviert: true }), opt('A'), opt('B')]

  test('vorhandene Vorgabe gilt', () => {
    assert.equal(startwert(mitPlatzhalter, 'B', false), 'B')
  })

  test('ausdrücklich gewählter (gesperrter) Platzhalter bleibt — required greift dann', () => {
    assert.equal(startwert(mitPlatzhalter, '', false), '')
  })

  test('ohne passende Vorgabe: erste nicht gesperrte Option', () => {
    assert.equal(startwert(mitPlatzhalter, 'weg', false), 'A')
    assert.equal(startwert(mitPlatzhalter, undefined, false), 'A')
    assert.equal(startwert([opt('—', { wert: '' }), opt('A')], undefined, false), '')
  })

  test('Zahlen als Vorgabe', () => {
    assert.equal(startwert([opt('1'), opt('5')], 5, false), '5')
  })

  test('Mehrfachauswahl: nur vorhandene Werte, sonst nichts', () => {
    assert.deepEqual(startwert(mitPlatzhalter, ['B', 'weg'], true), ['B'])
    assert.deepEqual(startwert(mitPlatzhalter, undefined, true), [])
  })

  test('leere Liste → leerer Wert', () => {
    assert.equal(startwert([], 'x', false), '')
  })
})

describe('Kurzanlage: Kontakt aus einem Namensfeld', async () => {
  const { kontaktAusKurzanlage } = await import('../src/modules/kontakte/kurzanlage.ts')

  test('Lieferant ist eine Firma', () => {
    assert.deepEqual(kontaktAusKurzanlage('lieferant', { name: '  Shenzhen  Foo Co. ', email: '' }), {
      name: 'Shenzhen Foo Co.',
      is_company: true,
      is_customer: false,
      is_vendor: true,
      email: undefined,
    })
  })

  test('Kunde als Person: letztes Wort ist der Nachname', () => {
    const k = kontaktAusKurzanlage('kunde', { name: 'Anna Maria Müller', art: 'person', email: 'a@b.de' })
    assert.deepEqual(k, {
      vorname: 'Anna Maria',
      nachname: 'Müller',
      is_company: false,
      is_customer: true,
      is_vendor: false,
      email: 'a@b.de',
    })
    assert.equal((kontaktAusKurzanlage('kunde', { name: 'Cher' }) as { nachname: string }).nachname, 'Cher')
  })

  test('Kunde als Firma und ohne Namen', () => {
    assert.equal((kontaktAusKurzanlage('kunde', { name: 'ACME GmbH', art: 'firma' }) as { is_company: boolean }).is_company, true)
    assert.deepEqual(kontaktAusKurzanlage('kunde', { name: '   ' }), { fehler: 'Bitte einen Namen angeben' })
  })
})
