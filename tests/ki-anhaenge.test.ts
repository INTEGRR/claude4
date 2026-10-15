import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ANHAENGE_JE_NACHRICHT,
  MAX_ANHANG_BYTES,
  NUR_ANHANG_TEXT,
  anhaengeLesen,
  anhangBytesGesamt,
  base64Bytes,
  nachrichtInhalt,
} from '../src/modules/ki/anhaenge.ts'
import { belegPositionenPruefen } from '../src/modules/prozesse/registry/einkauf.ts'
import { registrierteAktion } from '../src/modules/prozesse/registry/index.ts'
import { kiKatalog } from '../src/modules/prozesse/introspektion.ts'
import { aktionPruefen } from '../src/modules/prozesse/torwaechter.ts'

/**
 * Anhänge im KI-Chat (2026-10-15): Belege als Bild oder PDF gehen mit der
 * Frage an das Modell; aus einer Commercial Invoice entsteht EIN Vorschlag
 * einkauf.bestellung_erfassen. Hier der pure Teil — Prüfung der Anfrage,
 * Blockbau, Schema und Zeilenregel der Aktion.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('KI-Chat: Anhänge lesen', () => {
  test('Bild und PDF gehen durch, Unbekanntes nicht', () => {
    const ok = anhaengeLesen([
      { name: 'rechnung.png', mime: 'image/png', data: PNG },
      { name: 'pi.pdf', mime: 'application/pdf', data: 'JVBERi0xLjQK' },
    ])
    assert.ok(ok.ok)
    assert.equal(ok.wert.length, 2)
    assert.equal(ok.wert[0].mime, 'image/png')

    const falsch = anhaengeLesen([{ name: 'liste.xlsx', mime: 'application/vnd.ms-excel', data: PNG }])
    assert.ok(!falsch.ok)
    assert.match(falsch.fehler, /nur JPEG, PNG, WebP, GIF und PDF/)
  })

  test('ohne Anhänge: leere Liste; Müll wird benannt', () => {
    assert.deepEqual(anhaengeLesen(undefined), { ok: true, wert: [] })
    assert.ok(!anhaengeLesen('x').ok)
    assert.ok(!anhaengeLesen([{ name: 'a', mime: 'image/png' }]).ok)
    const keinBase64 = anhaengeLesen([{ name: 'a.png', mime: 'image/png', data: 'nicht base64!!' }])
    assert.ok(!keinBase64.ok)
    assert.match(keinBase64.fehler, /kein base64/)
  })

  test('zu groß und zu viele werden abgewiesen', () => {
    const riesig = 'A'.repeat(Math.ceil(((MAX_ANHANG_BYTES + 1024) * 4) / 3 / 4) * 4)
    const gross = anhaengeLesen([{ name: 'foto.jpg', mime: 'image/jpeg', data: riesig }])
    assert.ok(!gross.ok)
    assert.match(gross.fehler, /größer als 3 MB/)

    const viele = anhaengeLesen(
      Array.from({ length: MAX_ANHAENGE_JE_NACHRICHT + 1 }, (_, i) => ({ name: `${i}.png`, mime: 'image/png', data: PNG })),
    )
    assert.ok(!viele.ok)
    assert.match(viele.fehler, /Höchstens/)
  })

  test('Rohbytes aus base64 ohne Dekodieren', () => {
    assert.equal(base64Bytes('QUJD'), 3)
    assert.equal(base64Bytes('QUI='), 2)
    assert.equal(base64Bytes('QQ=='), 1)
    assert.equal(anhangBytesGesamt([{ anhaenge: [{ name: 'a', mime: 'image/png', data: 'QUJD' }] }, {}]), 3)
  })
})

describe('KI-Chat: Nachricht mit Anhängen', () => {
  test('ohne Anhang bleibt es der Text', () => {
    assert.equal(nachrichtInhalt('Wie viele Schrauben?'), 'Wie viele Schrauben?')
  })

  test('Anhänge stehen vor dem Text, der Text nennt die Dateinamen', () => {
    const inhalt = nachrichtInhalt('Erfass die Bestellung.', [
      { name: 'CH2026092142.png', mime: 'image/png', data: PNG },
      { name: 'pi.pdf', mime: 'application/pdf', data: 'JVBERi0xLjQK' },
    ])
    assert.ok(Array.isArray(inhalt))
    assert.equal(inhalt.length, 3)
    assert.equal(inhalt[0].type, 'image')
    assert.equal(inhalt[1].type, 'document')
    const text = inhalt[2]
    assert.equal(text.type, 'text')
    assert.match((text as { text: string }).text, /\[Anhang 1: CH2026092142\.png\] \[Anhang 2: pi\.pdf\]/)
    assert.match((text as { text: string }).text, /Erfass die Bestellung\./)
  })

  test('nur eine Datei, kein Text: Standardauftrag', () => {
    const inhalt = nachrichtInhalt('  ', [{ name: 'a.png', mime: 'image/png', data: PNG }])
    assert.ok(Array.isArray(inhalt))
    assert.match((inhalt.at(-1) as { text: string }).text, new RegExp(NUR_ANHANG_TEXT))
  })
})

describe('Bestellung aus Beleg erfassen: Katalog und Schema', () => {
  test('die Aktion ist KI-sichtbar, Beleg ablegen bewusst nicht', () => {
    const katalog = kiKatalog()
    const eintrag = katalog.find((a) => a.name === 'einkauf.bestellung_erfassen')
    assert.ok(eintrag, 'einkauf.bestellung_erfassen im KI-Katalog')
    assert.match(eintrag.felder, /lieferant, lieferant_neu\?, .*positionen, waehrung\?, .*bestaetigen\?, bezahlt\?/)
    assert.equal(katalog.some((a) => a.name === 'einkauf.beleg_ablegen'), false)
    assert.equal(registrierteAktion('einkauf.beleg_ablegen')?.bindung, 'beleg')
  })

  test('Schema: Vorgaben, Währung, Zusammenfassung', () => {
    const { werte, aktion } = aktionPruefen('einkauf.bestellung_erfassen', {
      parameter: {
        lieferant: 'Shenzhen DingShuo',
        lieferant_neu: true,
        lieferant_land: 'CN',
        positionen: [
          { artikel_neu: 'Philips Flat Head Screw M2x0.4x4mm', sku_neu: 'SCR-M2X4-BK', menge: 10000, preis: 0.011 },
          { produkt: 'SCR-M3X4-MS', menge: 2000, preis: 0.048 },
        ],
        waehrung: 'USD',
        incoterm_code: 'DDP',
        referenz: 'CH2026092142',
        versandkosten: 75,
        bezahlt: true,
        bezahlt_betrag: 321,
        bezahlt_am: '2026-09-22',
      },
    })
    assert.equal(werte.bestaetigen, true, 'bestaetigen ist Vorgabe')
    assert.equal(werte.lieferant_neu, true)
    const text = aktion.zusammenfassung?.(werte as never) ?? ''
    assert.match(text, /Shenzhen DingShuo \(neu\) in USD, Beleg CH2026092142/)
    assert.match(text, /10000 × Philips Flat Head Screw M2x0\.4x4mm \(neu\), 2000 × SCR-M3X4-MS \+ Fracht 75 — bestätigt, bezahlt 321 USD/)

    assert.throws(
      () => aktionPruefen('einkauf.bestellung_erfassen', { parameter: { lieferant: 'X', positionen: [], waehrung: 'US' } }),
      /positionen|waehrung/,
    )
    assert.throws(
      () => aktionPruefen('einkauf.bestellung_erfassen', { parameter: { lieferant: 'X', positionen: [{ produkt: 'A', menge: 1 }], bezahlt_am: '22.09.2026' } }),
      /JJJJ-MM-TT/,
    )
  })

  test('jede Zeile braucht genau einen Weg zum Artikel', () => {
    assert.equal(belegPositionenPruefen([{ produkt: 'A', menge: 1 }, { artikel_neu: 'B', menge: 2 }]), null)
    assert.match(belegPositionenPruefen([{ produkt: 'A', menge: 1 }, { menge: 2 }]) ?? '', /Position 2: produkt .* oder artikel_neu/)
    assert.match(belegPositionenPruefen([{ produkt: 'A', artikel_neu: 'A', menge: 1 }]) ?? '', /Position 1: entweder/)
    assert.match(belegPositionenPruefen([{ produkt: '  ', menge: 1 }]) ?? '', /Position 1/)
  })
})
