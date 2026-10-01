import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROXY_FAKE_SECRET,
  PROXY_ZEITFENSTER_SEKUNDEN,
  proxyNachricht,
  proxySchluessel,
  proxySignaturPruefen,
  proxySignieren,
} from '../src/modules/integrationen/shopify-proxy.ts'
import {
  LIQUID_AUSDRUECKE,
  STANDARD_PFAD,
  dankeSeite,
  formularSeite,
  liquidSicher,
  nichtGefundenSeite,
  nichtVerfuegbarSeite,
  pfadPraefix,
  reparaturShopUrl,
  stoerungSeite,
} from '../src/modules/reparatur/shop-seiten.ts'
import { ANFRAGE_BESCHRIFTUNG, ANFRAGE_FELDER } from '../src/modules/shared/reparaturanfrage.ts'

/**
 * Reparaturformular im Shop (App Proxy, Entscheidungslog 2026-10-01) — die
 * beiden puren Hälften: die Signaturprüfung (sie ist die ganze
 * Zugangskontrolle der Route) und die Seiten (Liquid-Escaping, kein Hinweis
 * auf das System dahinter). Der Weg durch Route und Datenbank steht in
 * tests/prozesse/shop-reparatur.test.ts.
 */

// --- Signatur ---------------------------------------------------------------

/**
 * Testvektoren mit Shopifys Beispiel-Secret „hush". Die drei in der
 * Shopify-Doku abgedruckten Signaturen werden exakt nachgerechnet (Shop
 * `shop-name.myshopify.com`): angemeldet (4c68c862…), Gast mit leerer
 * Kunden-ID (e072b6d7…) und ohne Kunden-ID (a9718877…) — siehe Test
 * „Shopifys abgedruckte Signaturen". Der Vektor darunter (some-shop) ist mit
 * demselben Algorithmus gerechnet.
 */
const VEKTOR_SECRET = 'hush'
const VEKTOR_QUERY =
  'extra=1&extra=2&shop=some-shop.myshopify.com&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555'
const VEKTOR_SIGNATUR = '2f40422c390a097f51a663391489cc5c5e234dd49badf100fb7ac0433a0e4f0f'
const VEKTOR_ZEIT = 1317327555 * 1000
const VEKTOR_SHOP = 'some-shop.myshopify.com'

function signiert(query: string, secret = VEKTOR_SECRET): URLSearchParams {
  const p = new URLSearchParams(query)
  p.set('signature', proxySignieren(p, secret))
  return p
}

describe('App Proxy: Signatur', () => {
  test('die signierte Nachricht entspricht wörtlich Shopifys Beispiel', () => {
    // Beispiel aus shopify.dev („Customer logged in"), Signatur weggelassen.
    const doku = new URLSearchParams(
      'extra=1&extra=2&shop={shop}.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb',
    )
    assert.equal(
      proxyNachricht(doku),
      'extra=1,2logged_in_customer_id=1path_prefix=/apps/awesome_reviewsshop={shop}.myshopify.comtimestamp=1317327555',
    )
    // Gast: leere Kunden-ID bleibt als Schlüssel ohne Wert stehen.
    doku.set('logged_in_customer_id', '')
    assert.equal(
      proxyNachricht(doku),
      'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop={shop}.myshopify.comtimestamp=1317327555',
    )
  })

  test('Shopifys abgedruckte Signaturen (shopify.dev, Secret „hush") werden exakt nachgerechnet', () => {
    const basis = 'extra=1&extra=2&shop=shop-name.myshopify.com&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555'
    const faelle: [string, string][] = [
      [`${basis}&logged_in_customer_id=1`, '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb'],
      [`${basis}&logged_in_customer_id=`, 'e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb'],
      [basis, 'a9718877bea71c2484f91608a7eaea1532bdf71f5c56825065fa4ccabe549ef3'],
    ]
    for (const [query, signatur] of faelle) {
      const p = new URLSearchParams(query)
      assert.equal(proxySignieren(p, 'hush'), signatur, query)
      p.set('signature', signatur)
      assert.deepEqual(proxySignaturPruefen(p, 'hush', VEKTOR_ZEIT, 'shop-name.myshopify.com'), { ok: true })
    }
  })

  test('Testvektor: Secret „hush", wiederholte Schlüssel, dekodierter path_prefix', () => {
    const p = new URLSearchParams(VEKTOR_QUERY)
    assert.equal(
      proxyNachricht(p),
      'extra=1,2path_prefix=/apps/awesome_reviewsshop=some-shop.myshopify.comtimestamp=1317327555',
    )
    assert.equal(proxySignieren(p, VEKTOR_SECRET), VEKTOR_SIGNATUR)
    p.set('signature', VEKTOR_SIGNATUR)
    assert.deepEqual(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP), { ok: true })
    // Großbuchstaben-Hex ist dieselbe Signatur.
    p.set('signature', VEKTOR_SIGNATUR.toUpperCase())
    assert.equal(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP).ok, true)
  })

  test('falsches Secret, fehlende oder verfälschte Signatur werden abgewiesen', () => {
    const p = signiert(VEKTOR_QUERY)
    assert.deepEqual(proxySignaturPruefen(p, 'anders', VEKTOR_ZEIT, VEKTOR_SHOP), {
      ok: false,
      grund: 'signatur_falsch',
    })

    const ohne = new URLSearchParams(VEKTOR_QUERY)
    assert.deepEqual(proxySignaturPruefen(ohne, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP), {
      ok: false,
      grund: 'signatur_fehlt',
    })

    const kurz = signiert(VEKTOR_QUERY)
    kurz.set('signature', 'abc')
    assert.equal(proxySignaturPruefen(kurz, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP).ok, false)

    // Wer die Kunden-ID austauscht, um fremde Daten vorbelegt zu bekommen, fällt durch.
    const kunde = signiert(`${VEKTOR_QUERY}&logged_in_customer_id=1`)
    kunde.set('logged_in_customer_id', '2')
    assert.deepEqual(proxySignaturPruefen(kunde, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP), {
      ok: false,
      grund: 'signatur_falsch',
    })

    assert.deepEqual(proxySignaturPruefen(p, '', VEKTOR_ZEIT, VEKTOR_SHOP), {
      ok: false,
      grund: 'kein_schluessel',
    })
  })

  test('wiederholte Schlüssel: Reihenfolge und Vollständigkeit der Werte zählen', () => {
    const p = signiert(VEKTOR_QUERY)
    const vertauscht = new URLSearchParams(p)
    vertauscht.delete('extra')
    vertauscht.append('extra', '2')
    vertauscht.append('extra', '1')
    assert.equal(proxySignaturPruefen(vertauscht, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP).ok, false)

    const angehaengt = new URLSearchParams(p)
    angehaengt.append('extra', '3')
    assert.equal(proxySignaturPruefen(angehaengt, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP).ok, false)
  })

  test(`Zeitstempel: höchstens ${PROXY_ZEITFENSTER_SEKUNDEN} Sekunden Abweichung, in beide Richtungen`, () => {
    const p = signiert(VEKTOR_QUERY)
    const fenster = PROXY_ZEITFENSTER_SEKUNDEN * 1000
    assert.equal(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT + fenster, VEKTOR_SHOP).ok, true)
    assert.deepEqual(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT + fenster + 1000, VEKTOR_SHOP), {
      ok: false,
      grund: 'zeitstempel',
    })
    assert.equal(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT - fenster - 1000, VEKTOR_SHOP).ok, false)

    const ohneZeit = signiert('shop=some-shop.myshopify.com&path_prefix=%2Fapps%2Freparatur')
    assert.deepEqual(proxySignaturPruefen(ohneZeit, VEKTOR_SECRET, VEKTOR_ZEIT, VEKTOR_SHOP), {
      ok: false,
      grund: 'zeitstempel',
    })
  })

  test('fremder Shop wird abgewiesen, ohne konfigurierten Shop nicht geprüft', () => {
    const p = signiert(VEKTOR_QUERY)
    assert.deepEqual(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT, 'anvil.myshopify.com'), {
      ok: false,
      grund: 'shop',
    })
    assert.equal(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT, 'SOME-SHOP.myshopify.com').ok, true)
    assert.equal(proxySignaturPruefen(p, VEKTOR_SECRET, VEKTOR_ZEIT, '').ok, true)
  })

  test('Schlüssel: Client Secret, im Fake-Betrieb die Attrappe, sonst keiner (= abweisen)', () => {
    assert.equal(proxySchluessel({ SHOPIFY_CLIENT_SECRET: 'geheim', SHOPIFY_FAKE: '1' }), 'geheim')
    assert.equal(proxySchluessel({ SHOPIFY_FAKE: '1' }), PROXY_FAKE_SECRET)
    assert.equal(proxySchluessel({ SHOPIFY_CLIENT_SECRET: '  ' }), '')
    assert.equal(proxySchluessel({}), '')
  })
})

// --- Seiten -----------------------------------------------------------------

const BOESE = '{{ shop.secret }} {% render "x" %} <script>alert(1)</script> "\' 100%'

/** Die Seite ohne die fest eingebauten Liquid-Ausdrücke — darin darf kein Tag mehr stehen. */
function ohneEigeneLiquidAusdruecke(html: string): string {
  let rest = html
  for (const ausdruck of LIQUID_AUSDRUECKE) rest = rest.split(ausdruck).join('')
  return rest
}

function skripte(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

describe('App Proxy: Liquid-Escaping', () => {
  test('liquidSicher kodiert HTML und die Liquid-Zeichen { } %', () => {
    assert.equal(
      liquidSicher('{{ x }} {% y %} <b>&"\''),
      '&#123;&#123; x &#125;&#125; &#123;&#37; y &#37;&#125; &lt;b&gt;&amp;&quot;&#39;',
    )
    assert.equal(liquidSicher(null), '')
    assert.equal(liquidSicher('&#123;'), '&amp;#123;', 'bereits kodierte Entitäten werden nicht durchgereicht')
  })

  test('kein Kundenwert wird zu einem Liquid-Tag — in keinem Feld, keiner Meldung, keiner Bestellnummer', () => {
    const werte = Object.fromEntries(ANFRAGE_FELDER.map((f) => [f, BOESE]))
    const fehler = Object.fromEntries(ANFRAGE_FELDER.map((f) => [f, BOESE]))
    const html = formularSeite({
      aktion: '/apps/reparatur',
      werte,
      fehler,
      meldung: BOESE,
      bestellungen: [BOESE, '#1042'],
      vorausgefuellt: true,
    })
    const rest = ohneEigeneLiquidAusdruecke(html)
    assert.ok(!rest.includes('{{'), 'kein {{ außer den eigenen Ausdrücken')
    assert.ok(!rest.includes('{%'), 'kein {% außerhalb der eigenen Ausdrücke')
    assert.ok(!html.includes('<script>alert'), 'kein eingeschleustes Skript')
    assert.ok(html.includes('&#123;&#123; shop.secret &#125;&#125;'), 'der Text bleibt sichtbar, nur entschärft')
    assert.ok(html.includes('100&#37;'))
    assert.ok(html.includes('<option value="#1042"></option>'))
  })

  test('die Danke-Seite entschärft auch die Vorgangsnummer und räumt den POST aus dem Verlauf', () => {
    const html = dankeSeite('VG/00042')
    assert.ok(html.includes('VG/00042'))
    assert.ok(html.includes('history.replaceState'))
    assert.ok(!ohneEigeneLiquidAusdruecke(dankeSeite('{{ x }}')).includes('{{'))
    assert.ok(!dankeSeite().includes('Nummer'), 'ohne Nummer (Honigtopf) bleibt der Text allgemein')
  })

  test('Hinweisseiten enthalten gar kein Liquid — sie müssen auch ungerendert stimmen', () => {
    for (const html of [nichtGefundenSeite('/apps/reparatur'), stoerungSeite('/apps/reparatur'), nichtVerfuegbarSeite()]) {
      assert.ok(!html.includes('{{') && !html.includes('{%'))
    }
  })

  test('path_prefix: nur schlichte Pfade, sonst der Standard', () => {
    assert.equal(pfadPraefix('/apps/reparatur'), '/apps/reparatur')
    assert.equal(pfadPraefix('/tools/service-anfrage'), '/tools/service-anfrage')
    for (const boese of ['', null, 'javascript:alert(1)', '//evil.example', '/apps/x"onmouseover=1', 'apps/reparatur', '/']) {
      assert.equal(pfadPraefix(boese), STANDARD_PFAD, String(boese))
    }
    assert.ok(formularSeite({ aktion: '//evil.example', werte: {} }).includes(`action="${STANDARD_PFAD}"`))
  })
})

describe('App Proxy: Seiten sind selbsttragend und verraten nichts', () => {
  const formular = formularSeite({ aktion: '/apps/reparatur', werte: { land: 'DE' } })
  const alle = [formular, dankeSeite('VG/00001'), nichtGefundenSeite('/apps/reparatur'), stoerungSeite('/x'), nichtVerfuegbarSeite()]

  test('keine Next-Assets, keine absoluten URLs, kein Systemname, keine Marke', () => {
    for (const html of alle) {
      assert.ok(!html.includes('/_next'), '/_next')
      assert.ok(!/https?:\/\//.test(html), 'absolute URL')
      assert.ok(!/krnl/i.test(html), 'KRNL')
      assert.ok(!/\bERP\b/.test(html), 'ERP')
      assert.ok(!/hexcore/i.test(html), 'Marke')
      assert.ok(!/<link\b|<img\b|<iframe\b|\bsrc=/.test(html), 'keine nachgeladenen Ressourcen')
    }
  })

  test('Theme-Rahmen, Theme-Variablen mit Rückfall, Klassen mit Präfix rp-', () => {
    for (const html of alle) {
      assert.ok(html.includes('<div class="page-width rp">'))
      assert.ok(html.includes('rgb(var(--color-foreground,18,18,18))'))
      assert.ok(html.includes('var(--font-body-family,inherit)'))
      const klassen = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
      for (const k of klassen) assert.ok(k === 'page-width' || k === 'rp' || k.startsWith('rp-'), k)
    }
  })

  test('das Formular: alle Felder mit den Kundenbeschriftungen, Honigtopf, POST an den Shop-Pfad', () => {
    assert.match(formular, /<form id="rp-formular" class="rp-form" method="post" action="\/apps\/reparatur"/)
    for (const feld of ANFRAGE_FELDER) {
      assert.ok(formular.includes(`name="${feld}"`), feld)
      assert.ok(formular.includes(`>${liquidSicher(ANFRAGE_BESCHRIFTUNG[feld])}`), `Beschriftung ${feld}`)
    }
    assert.ok(formular.includes('name="webseite"'), 'Honigtopf')
    assert.ok(formular.includes('{{ shop.name | escape }}'), 'Shopname kommt aus Liquid')
    assert.match(formular, /<option value="DE" selected>Deutschland<\/option>/)
    assert.match(formular, /name="kontakt_name" maxlength="120" required/)
    assert.match(formular, /minlength="10"/)
  })

  test('Inline-Skript: höchstens 40 Zeilen, ohne Liquid-Zeichenfolgen', () => {
    const [skript] = skripte(formular)
    assert.ok(skript, 'Formular hat ein Skript')
    assert.ok(skript.trim().split('\n').length <= 40, 'höchstens 40 Zeilen')
    for (const html of alle) {
      for (const s of skripte(html)) assert.ok(!s.includes('{{') && !s.includes('{%'))
      const stil = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
      assert.ok(!stil.includes('{{') && !stil.includes('{%'))
    }
  })

  test('ein unbekanntes Land aus dem Kundenkonto bleibt auswählbar', () => {
    assert.match(formularSeite({ aktion: '/apps/reparatur', werte: { land: 'US' } }), /<option value="US" selected>US<\/option>/)
  })
})

describe('REPARATUR_SHOP_URL', () => {
  test('nur https-Adressen leiten um', () => {
    assert.equal(reparaturShopUrl({ REPARATUR_SHOP_URL: 'https://anvil.gg/apps/reparatur' }), 'https://anvil.gg/apps/reparatur')
    assert.equal(reparaturShopUrl({ REPARATUR_SHOP_URL: '  ' }), null)
    assert.equal(reparaturShopUrl({}), null)
    assert.equal(reparaturShopUrl({ REPARATUR_SHOP_URL: 'http://anvil.gg/apps/reparatur' }), null)
    assert.equal(reparaturShopUrl({ REPARATUR_SHOP_URL: 'anvil.gg/apps/reparatur' }), null)
    assert.equal(reparaturShopUrl({ REPARATUR_SHOP_URL: 'https://localhost/x' }), null)
  })
})
