import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDARBEIT,
  PLATZHALTER_FIRMA,
  PRUEFPUNKTE,
  type ProduktivgangStand,
  produktivgangBewerten,
} from '../src/modules/einstellungen/produktivgang.ts'

/**
 * Produktivgang (Entscheidungslog 2026-10-17): die Checkliste bewertet einen
 * Stand zu Ampeln. Ein frischer Werkszustand ist rot bei Firma,
 * Nummernkreisen, Rechnungsmodus und Shopify; eine fertig eingerichtete
 * Instanz ist durchgehend grün.
 */

const BEREIT: ProduktivgangStand = {
  env: {
    SESSION_SECRET: 'x', CRON_SECRET: 'x', ZWEIFAKTOR_SCHLUESSEL: 'x',
    SHOPIFY_SHOP_DOMAIN: 'anvil.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'x',
    DHL_API_KEY: 'x', DHL_API_SECRET: 'x', DHL_GKP_USER: 'x', DHL_GKP_PASSWORD: 'x', DHL_BILLING_NUMBER: 'x',
    RESEND_API_KEY: 'x', MAIL_FROM: 'krnl@anvil.gg', TRACK17_API_KEY: 'x', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'x',
  },
  firma: {
    name: 'ANVIL GmbH', street: 'Neue Friedhofstraße', zip: '32457', city: 'Porta Westfalica', ust_id: 'DE123',
    steuernummer: '335/5754/6137', registergericht: 'Bad Oeynhausen', handelsregister: 'HRB 16523',
    geschaeftsfuehrung: 'Patrick Düker', iban: 'DE00',
  },
  nummernkreise: [{ code: 'kundenrechnung', next_number: 7813 }, { code: 'gutschrift', next_number: 1417 }],
  rechnungModus: 'scharf',
  probeRechnungen: 0,
  shopifyModus: 'schreiben',
  gestoerteDienste: [],
  kiRegionGesetzt: true,
  kiRegionBereit: true,
  adminsOhne2fa: 0,
  startkontoAktiv: false,
  offeneEinrichtung: 0,
  abhaengigkeiten: { geprueftAm: '2026-10-18T06:00:00Z', kritisch: 0, hoch: 0, mittel: 0, niedrig: 0, pakete: [], fehler: null },
}

const ton = (s: ProduktivgangStand) => Object.fromEntries(produktivgangBewerten(s).map((p) => [p.schluessel, p.ton]))

describe('Produktivgang', () => {
  test('eingerichtete Instanz: alles grün', () => {
    const rot = produktivgangBewerten(BEREIT).filter((p) => p.ton !== 'ok')
    assert.deepEqual(rot.map((p) => `${p.schluessel}: ${p.text}`), [])
  })

  test('frischer Werkszustand: Firma, Nummernkreise, Rechnungen und Shopify rot', () => {
    const t = ton({
      ...BEREIT,
      firma: { name: PLATZHALTER_FIRMA },
      nummernkreise: [{ code: 'kundenrechnung', next_number: 1 }, { code: 'gutschrift', next_number: 1 }],
      rechnungModus: 'test',
      shopifyModus: 'lesen',
      startkontoAktiv: true,
      offeneEinrichtung: 7,
    })
    for (const k of ['firma', 'nummernkreise', 'rechnungsmodus', 'shopify_modus', 'startkonto', 'einrichtung']) {
      assert.equal(t[k], 'warn', k)
    }
  })

  test('Einzelregeln: Testbelege, Attrappe, Störung, fehlende Pflichtangabe, KI-Region', () => {
    const scharfMitProbe = produktivgangBewerten({ ...BEREIT, probeRechnungen: 3 }).find((p) => p.schluessel === 'rechnungsmodus')!
    assert.equal(scharfMitProbe.ton, 'warn')
    assert.match(scharfMitProbe.text, /Testbelege/)

    assert.equal(ton({ ...BEREIT, env: { ...BEREIT.env, SHOPIFY_FAKE: '1' } }).shopify, 'warn', 'Attrappe vor dem Stichtag abschalten')
    assert.equal(ton({ ...BEREIT, gestoerteDienste: ['dhl'] }).dhl, 'warn')

    const firma = produktivgangBewerten({ ...BEREIT, firma: { ...BEREIT.firma, ust_id: '' } }).find((p) => p.schluessel === 'firma')!
    assert.match(firma.text, /USt-IdNr\./)

    assert.equal(ton({ ...BEREIT, kiRegionGesetzt: false }).ki, 'warn')
    assert.equal(ton({ ...BEREIT, kiRegionBereit: false }).ki, 'warn')
    const nur = produktivgangBewerten({ ...BEREIT, nummernkreise: [{ code: 'kundenrechnung', next_number: 7813 }, { code: 'gutschrift', next_number: 1 }] })
      .find((p) => p.schluessel === 'nummernkreise')!
    assert.match(nur.text, /^GU- beginnt noch bei 1/)
  })

  test('Abhängigkeiten: hohe oder kritische Lücke rot, ungeprüfte Fassung grau, gescheiterte Prüfung rot', () => {
    const a = BEREIT.abhaengigkeiten
    const luecke = produktivgangBewerten({ ...BEREIT, abhaengigkeiten: { ...a, kritisch: 1, hoch: 2, pakete: ['next', 'sharp'] } })
      .find((p) => p.schluessel === 'abhaengigkeiten')!
    assert.equal(luecke.ton, 'warn')
    assert.match(luecke.text, /^1 kritisch, 2 hoch in next, sharp/)
    assert.equal(ton({ ...BEREIT, abhaengigkeiten: { ...a, mittel: 3 } }).abhaengigkeiten, 'ok', 'mittlere Befunde machen den Punkt nicht rot')
    assert.equal(ton({ ...BEREIT, abhaengigkeiten: { ...a, geprueftAm: null } }).abhaengigkeiten, 'off')
    assert.equal(ton({ ...BEREIT, abhaengigkeiten: { ...a, fehler: 'ENOTFOUND registry.npmjs.org' } }).abhaengigkeiten, 'warn')
  })

  test('optionale Anbindungen ohne Schlüssel sind grau, nicht rot', () => {
    const { TRACK17_API_KEY: _t, TELEGRAM_BOT_TOKEN: _b, TELEGRAM_CHAT_ID: _c, ...ohne } = BEREIT.env
    const t = ton({ ...BEREIT, env: ohne })
    assert.equal(t.track17, 'off')
    assert.equal(t.telegram, 'off')
  })

  test('Schlüssel eindeutig, jeder Punkt verlinkt, Handarbeit nicht leer', () => {
    const schluessel = PRUEFPUNKTE.map((p) => p.schluessel)
    assert.equal(new Set(schluessel).size, schluessel.length)
    for (const p of PRUEFPUNKTE) assert.match(p.link, /^(\/|https:\/\/github\.com\/)/, p.schluessel)
    assert.ok(HANDARBEIT.length >= 3)
  })
})
