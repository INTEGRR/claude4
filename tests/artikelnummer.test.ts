/**
 * Artikelnummer-Vorschlag (Entscheidungslog 2026-11-28): das Muster ist aus
 * dem Bestand abgelesen — also muss der Vorschlag die echten Nummern treffen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIKELNUMMER_MUSTER, artikelnummerRumpf, artikelnummerVorschlaege, artikelnummerVorschlag,
} from '../src/modules/shared/artikelnummer.ts'

// Name → Nummer, wie sie am 28.11. in der Produktion stehen.
const BESTAND: [string, string][] = [
  ['Native 1800 Case Black', 'CS-1800-BLK-001'],
  ['Native 1800 Case Blue', 'CS-1800-BLU-001'],
  ['Native 1800 Case Green', 'CS-1800-GRE-001'],
  ['ANVIL Native 75 Case (Farbe: Plague Black)', 'CS-N75-BLK-001'],
  ['Native 1800 Mounting Plate FR4', 'MP-F-1800-001'],
  ['Native 1800 Mounting Plate PC', 'MP-P-1800-001'],
  ['[MP-P-ISO-N75-001] Mounting Plate Polycarbonat ISO für N75', 'MP-P-ISO-N75-001'],
  ['Native 1800 PCB HE', 'PCB-HE-1800-001'],
  ['Native 1800 PCB MX', 'PCB-MX-1800-001'],
  ['Native 1800 USB Daughter Board', 'PCB-DB-1800-001'],
  ['NATIVE 75 Hot Swap PCB (Layout: ISO)', 'PCB-ISO-N75-001'],
  ['NATIVE 75 Hot Swap PCB (Layout: ANSI)', 'PCB-ANSI-N75-001'],
  ['Native 1800 Daughter Board Kabel', 'CBL-DB-1800-001'],
  ['USB-C Kabel mit Adapter', 'CBL-USBC-ADP-001'],
  ['Native 1800 Aluminium Clip Black', 'CLIP-ALU-1800-BLK-001'],
  ['[FM-B-N75-001] Bottom Foam für Native 75', 'FM-B-N75-001'],
  ['[FM-M-ISO-N75-001] Middle Foam ISO für Native 75', 'FM-M-ISO-N75-001'],
  ['Native 1800 Middle Foam Silikon', 'FM-M-SIL-1800-001'],
  ['Native 1800 Stabilizer groß (Spacebar)', 'STB-L-1800-001'],
  ['Native 1800 Stabilizer klein', 'STB-S-1800-001'],
  ['Native 1800 Keycaps Founders', 'KC-FND-1800-001'],
  ['Native 1800 Keycaps Standard White on Black', 'KC-STD-1800-001'],
  ['[KC-BOB-N75-001] Black on Black Keycaps', 'KC-BOB-001'],
  ['Quickstart Guide Native 1800', 'QS-1800-001'],
  ['[QS-N75-001] Quickstart Guide Native 75', 'QS-N75-001'],
  ['[GR-N75-001] Grommets für Native 75', 'GR-N75-001'],
  ['[KCP-001] Keycap Puller 2in1', 'KCP-001'],
  ['[ESD-001] ESD Sticker', 'ESD-001'],
  ['[RF-001] Rubber Feed Sticker', 'RF-001'],
  ['[CC-B-001] Coiled Cable Black', 'CC-BLK-001'],
  ['Gateron Jade Max HE Switch (linear, 36 g, einstellbar)', 'SW-GT-JMX-001'],
  ['Gateron Jade Gaming HE Switch (linear, 36 g, einstellbar)', 'SW-GT-JGA-001'],
  ['Gateron Jade Ultra HE Switch (linear, 30 g, einstellbar)', 'SW-GT-JUL-001'],
  ['Gateron Jade Silent HE Switch (linear, 33 g, einstellbar)', 'SW-GT-JSI-001'],
]

test('der Vorschlag trifft die vorhandenen Nummern', () => {
  for (const [name, nummer] of BESTAND) assert.equal(artikelnummerVorschlag({ produkt: name }), nummer, name)
})

test('Varianten: die Attributwerte fließen ein — die überschriebenen Switch-Nummern kommen zurück', () => {
  const sw = (wert: string) => artikelnummerVorschlag({ produkt: 'GATERON G Pro 3.0 Switches', werte: [wert] })
  assert.deepEqual(
    ['G PRO 2.0 Silver', 'G PRO 2.0 BLUE', 'G PRO 2.0 BROWN', 'G PRO 2.0 YELLOW'].map(sw),
    ['SW-GT-LS-001', 'SW-GT-CB-001', 'SW-GT-TB-001', 'SW-GT-LY-001'],
  )
  assert.equal(artikelnummerVorschlag({ produkt: 'Cherry MX2A Silent Red Switch' }), 'SW-CH-LSR-001')
  assert.equal(artikelnummerVorschlag({ produkt: 'NATIVE 75 Mounting Plate', werte: ['FR4'] }), 'MP-F-N75-001')
  assert.equal(artikelnummerVorschlag({ produkt: 'ANVIL Native 75 Case', werte: ['Cosmic Purple'] }), 'CS-N75-VLT-001')
})

test('Tastaturen: vierstellig, mit Modell, Farbe und Konfiguration', () => {
  assert.equal(
    artikelnummerVorschlag({
      produkt: 'NATIVE 1800 HE (QWERTZ) Plague Black',
      werte: ['FR4', 'Gateron - Jade Max', 'Standard'],
    }),
    'KB-HE-1800-BLK-FR-JMX-S-0001',
  )
  assert.equal(
    artikelnummerVorschlag({
      produkt: 'NATIVE 1800 MX (QWERTZ) Founders Edition',
      werte: ['PC', 'Cherry MX2A - Silent Red', 'Founders Split Space'],
    }),
    'KB-MX-1800-FE-PC-SR-FSP-0001',
  )
})

test('die Laufnummer zählt hoch, wenn die Nummer vergeben ist — Schreibweise egal', () => {
  assert.equal(artikelnummerVorschlag({ produkt: 'Native 1800 Case Black' }, ['CS-1800-BLK-001']), 'CS-1800-BLK-002')
  assert.equal(artikelnummerVorschlag({ produkt: 'Native 1800 Case Black' }, ['cs-1800-blk-001', 'CS-1800-BLK-002']), 'CS-1800-BLK-003')
  const mehrere = artikelnummerVorschlaege(
    [{ id: 'a', produkt: 'Poliertuch Mikrofaser' }, { id: 'b', produkt: 'Poliertuch Mikrofaser' }], [],
  )
  assert.deepEqual([...mehrere.values()], ['PM-001', 'PM-002'], 'untereinander eindeutig; unbekannte Art = Anfangsbuchstaben')
})

test('Rumpf ohne Laufnummer und der Text für die KI', () => {
  assert.equal(artikelnummerRumpf({ produkt: 'Philips Flat Head Screw M3x4mm, Carbon Steel, schwarz' }), 'SCR-M3X4-BLK')
  assert.equal(artikelnummerRumpf({ produkt: 'Philips Pan Head Screw M3x4mm, Messing' }), 'SCR-M3X4-BRS')
  assert.match(ARTIKELNUMMER_MUSTER, /ART-MERKMAL-MODELL-FARBE-LAUFNUMMER/)
  assert.match(ARTIKELNUMMER_MUSTER, /CS-1800-BLK-001/)
})
