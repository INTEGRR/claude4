/**
 * Reparaturformular im Shop (App Proxy, Entscheidungslog 2026-10-01) —
 * durch die echte Route: Request-Objekte mit signierter Query wie von
 * Shopify, Antworten als Liquid, Vorgänge in der Testdatenbank. Dazu die
 * Website-Route, die denselben Eingang nutzt (ein Codepfad, zwei Kanäle).
 *
 * Fake-Betrieb ohne Client Secret: die Route prüft gegen den festen
 * Attrappen-Schlüssel — übersprungen wird die Prüfung nie.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { PROXY_FAKE_SECRET, proxySignieren } from '../../src/modules/integrationen/shopify-proxy.ts'
import * as shop from '../../src/app/api/shopify/proxy/[[...pfad]]/route.ts'
import * as website from '../../src/app/api/reparaturanfrage/route.ts'

const DATENBANK = 'erp_shop_reparatur_check'
const SHOP = 'anvil-test.myshopify.com'
let h: Harness

before(async () => {
  process.env.SHOPIFY_FAKE = '1'
  delete process.env.SHOPIFY_CLIENT_SECRET
  delete process.env.RESEND_API_KEY
  process.env.SHOPIFY_SHOP_DOMAIN = SHOP
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

interface UrlOptionen {
  pfad?: string
  kunde?: string
  secret?: string
  shop?: string
  zeit?: number
}

function signierteUrl(o: UrlOptionen = {}): string {
  const p = new URLSearchParams({
    shop: o.shop ?? SHOP,
    logged_in_customer_id: o.kunde ?? '',
    path_prefix: '/apps/reparatur',
    timestamp: String(Math.floor((o.zeit ?? Date.now()) / 1000)),
  })
  p.set('signature', proxySignieren(p, o.secret ?? PROXY_FAKE_SECRET))
  return `https://erp.example.test/api/shopify/proxy${o.pfad ? `/${o.pfad}` : ''}?${p}`
}

const kontext = (pfad?: string[]) => ({ params: Promise.resolve(pfad ? { pfad } : {}) })

async function holen(o: UrlOptionen = {}): Promise<Response> {
  return shop.GET(new Request(signierteUrl(o)), kontext(o.pfad ? o.pfad.split('/') : undefined))
}

async function senden(felder: Record<string, string>, o: UrlOptionen = {}): Promise<Response> {
  return shop.POST(
    new Request(signierteUrl(o), {
      method: 'POST',
      body: new URLSearchParams(felder),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
    kontext(),
  )
}

const ANFRAGE = {
  kontakt_name: 'Erika Musterfrau',
  email: 'erika.shop@example.com',
  telefon: '+49 30 1234567',
  strasse: 'Prozessweg',
  hausnummer: '7',
  plz: '10115',
  ort: 'Berlin',
  land: 'DE',
  fehlerbeschreibung: 'Die Leertaste prellt — jeder zweite Anschlag kommt doppelt.',
  bestellnummer: '#1042',
  webseite: '',
}

async function anzahlVorgaenge(): Promise<number> {
  const [z] = await h.sql<{ n: number }[]>`
    select count(*)::int as n from vorgaenge where prozess_code = 'reparatur_anfrage'`
  return z.n
}

function liquidAntwort(res: Response): void {
  assert.equal(res.headers.get('content-type'), 'application/liquid; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store, private')
}

describe('Reparaturformular im Shop: Route, Signatur, Eingang', () => {
  test('ohne gültige Signatur: 401 als Klartext, kein HTML', async () => {
    const faelle: UrlOptionen[] = [
      { secret: 'falsch' },
      { shop: 'fremder-shop.myshopify.com' },
      { zeit: Date.now() - 5 * 60_000 },
    ]
    for (const o of faelle) {
      const res = await holen(o)
      assert.equal(res.status, 401, JSON.stringify(o))
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
      assert.ok(!(await res.text()).includes('<'))
    }
    const ohne = await shop.GET(new Request('https://erp.example.test/api/shopify/proxy?shop=x'), kontext())
    assert.equal(ohne.status, 401)
    const post = await shop.POST(
      new Request(signierteUrl({ secret: 'falsch' }), { method: 'POST', body: new URLSearchParams(ANFRAGE) }),
      kontext(),
    )
    assert.equal(post.status, 401)
    assert.equal(await anzahlVorgaenge(), 0, 'nichts angenommen')
  })

  test('GET zeigt das Formular als Liquid, ohne Spuren des Systems dahinter', async () => {
    const res = await holen()
    assert.equal(res.status, 200)
    liquidAntwort(res)
    const html = await res.text()
    assert.ok(html.includes('<form id="rp-formular"'))
    assert.ok(html.includes('action="/apps/reparatur"'))
    assert.ok(html.includes('{{ shop.name | escape }}'))
    assert.ok(!html.includes('/_next') && !/krnl/i.test(html) && !html.includes('erp.example.test'))
    assert.ok(!html.includes('aus deinem Kundenkonto'), 'Gast: nichts vorbelegt')
  })

  test('unbekannter Unterpfad: neutrale 404-Seite im Theme statt der Next-Seite', async () => {
    const res = await holen({ pfad: 'gibt/es/nicht' })
    assert.equal(res.status, 404)
    liquidAntwort(res)
    const html = await res.text()
    assert.ok(html.includes('Diese Seite gibt es nicht'))
    assert.ok(html.includes('href="/apps/reparatur"'))
  })

  test('POST mit Fehlern: Formular mit Eingaben und Meldungen, Liquid entschärft, nichts gespeichert', async () => {
    const res = await senden({
      ...ANFRAGE,
      email: 'keine-adresse',
      strasse: '',
      fehlerbeschreibung: 'Kaputt {{ shop.secret }} {% render "x" %}',
    })
    assert.equal(res.status, 200)
    liquidAntwort(res)
    const html = await res.text()
    assert.ok(html.includes('value="Erika Musterfrau"'), 'Eingaben bleiben stehen')
    assert.ok(html.includes('value="keine-adresse"'))
    assert.ok(html.includes('Bitte eine gültige E-Mail-Adresse angeben'))
    assert.ok(html.includes('Bitte ausfüllen'))
    assert.ok(html.includes('&#123;&#123; shop.secret &#125;&#125;'))
    assert.ok(!html.includes('{{ shop.secret') && !html.includes('{% render'))
    assert.equal(await anzahlVorgaenge(), 0)
  })

  test('POST gültig: Vorgang mit Quelle shop, Outbox-Bestätigung, Danke-Seite mit Nummer', async () => {
    const res = await senden(ANFRAGE)
    assert.equal(res.status, 200)
    liquidAntwort(res)
    const html = await res.text()
    const nummer = html.match(/Nummer (VG\/\d+)/)?.[1]
    assert.ok(nummer, 'Danke-Seite nennt die Vorgangsnummer')
    assert.ok(html.includes('history.replaceState'))

    const [v] = await h.sql<
      { id: string; state: string; quelle: string; absender_hash: string | null; zusatz: Record<string, string> }[]
    >`select id, state, quelle, absender_hash, zusatz from vorgaenge where number = ${nummer}`
    assert.equal(v.quelle, 'shop')
    assert.equal(v.state, 'neu')
    assert.ok(v.absender_hash, 'gedrosselt wird je Shop-Absender')
    assert.equal(v.zusatz.email, ANFRAGE.email)
    assert.equal(v.zusatz.bestellnummer, '#1042')
    assert.ok(!('webseite' in v.zusatz) && !('kanal' in v.zusatz), 'nur die Formularfelder im zusatz')

    const [job] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from integration_jobs
      where kind = 'send_repair_request_email' and payload ->> 'vorgang_id' = ${v.id}`
    assert.equal(job.n, 1)
    const [log] = await h.sql<{ message: string; actor: string }[]>`
      select message, actor from audit_log where model = 'vorgang' and record_id = ${v.id}`
    assert.match(log.message, /Formular im Shop/)
    assert.equal(log.actor, 'kundenformular')
  })

  test('doppelt abgeschickt: dieselbe Nummer, kein zweiter Vorgang', async () => {
    const vorher = await anzahlVorgaenge()
    const erste = (await h.sql<{ number: string }[]>`
      select number from vorgaenge where zusatz ->> 'email' = ${ANFRAGE.email}`)[0].number
    const res = await senden({ ...ANFRAGE, email: ANFRAGE.email.toUpperCase() })
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes(`Nummer ${erste}`))
    assert.equal(await anzahlVorgaenge(), vorher)

    // Gleichzeitig (Doppelklick ohne JavaScript): die Sperre je E-Mail
    // lässt nur einen Vorgang entstehen, beide sehen dieselbe Nummer.
    const gleichzeitig = { ...ANFRAGE, email: 'doppelklick@example.com' }
    const antworten = await Promise.all([senden(gleichzeitig), senden(gleichzeitig), senden(gleichzeitig)])
    const nummern = await Promise.all(antworten.map(async (r) => (await r.text()).match(/Nummer (VG\/\d+)/)?.[1]))
    assert.ok(nummern[0])
    assert.deepEqual(nummern, [nummern[0], nummern[0], nummern[0]])
    assert.equal(await anzahlVorgaenge(), vorher + 1)
  })

  test('Honigtopf: freundliche Danke-Seite ohne Nummer, nichts gespeichert', async () => {
    const vorher = await anzahlVorgaenge()
    const res = await senden({ ...ANFRAGE, email: 'bot@example.com', webseite: 'https://spam.example' })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('Danke!'))
    assert.ok(!html.includes('VG/'))
    assert.equal(await anzahlVorgaenge(), vorher)
  })

  test('angemeldeter Kunde: Vorbelegung aus partners.shopify_customer_id, Bestellungen als Vorschlag', async () => {
    const [p] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer, email, phone, street, house_number, zip, city, country_code, shopify_customer_id)
      values ('Max {{ Kunde }}', true, 'max@example.com', '+49 40 999', 'Hafenstraße', '12a', '20457', 'Hamburg', 'DE',
              'gid://shopify/Customer/777')
      returning id`
    await h.sql`insert into sales_orders (number, partner_id, source, shopify_order_id, shopify_order_name)
                values ('S-SHOP-1', ${p.id}, 'shopify', 'gid://shopify/Order/1', '#1042'),
                       ('S-SHOP-2', ${p.id}, 'shopify', 'gid://shopify/Order/2', '#1077')`

    const html = await (await holen({ kunde: '777' })).text()
    assert.ok(html.includes('aus deinem Kundenkonto'))
    assert.ok(html.includes('value="Max &#123;&#123; Kunde &#125;&#125;"'), 'auch Stammdaten werden entschärft')
    assert.ok(html.includes('value="max@example.com"'))
    assert.ok(html.includes('value="Hafenstraße"') && html.includes('value="12a"'))
    assert.ok(html.includes('value="20457"') && html.includes('value="Hamburg"'))
    assert.ok(html.includes('<option value="#1042"></option>') && html.includes('<option value="#1077"></option>'))

    const fremd = await (await holen({ kunde: '778' })).text()
    assert.ok(!fremd.includes('Hafenstraße') && !fremd.includes('aus deinem Kundenkonto'))
    const unsinn = await (await holen({ kunde: '777 or 1=1' })).text()
    assert.ok(!unsinn.includes('Hafenstraße'), 'nur numerische Kunden-IDs')
  })

  test('Drossel je Shop-Kunde: fünf in zehn Minuten, die sechste wird mit Meldung abgewiesen', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await senden(
        { ...ANFRAGE, email: 'viel@example.com', fehlerbeschreibung: `Taste ${i} hakt seit gestern.` },
        { kunde: '555' },
      )
      assert.ok((await res.text()).includes('VG/'), `Anfrage ${i}`)
    }
    const res = await senden(
      { ...ANFRAGE, email: 'anders@example.com', fehlerbeschreibung: 'Taste 6 hakt seit gestern.' },
      { kunde: '555' },
    )
    assert.equal(res.status, 429)
    liquidAntwort(res)
    assert.ok((await res.text()).includes('Zu viele Anfragen'))
    // Ein anderer Kunde ist nicht betroffen — die IP von Shopify zählt nicht.
    const anderer = await senden(
      { ...ANFRAGE, email: 'anders@example.com', fehlerbeschreibung: 'Taste 6 hakt seit gestern.' },
      { kunde: '556' },
    )
    assert.ok((await anderer.text()).includes('VG/'))
  })

  test('abgeschalteter Prozess: GET zeigt „nicht verfügbar", POST nimmt nichts an', async () => {
    await h.sql`update prozesse set aktiv = false where code = 'reparatur_anfrage'`
    try {
      const html = await (await holen()).text()
      assert.ok(html.includes('nicht online entgegen'))
      assert.ok(!html.includes('<form'))
      const vorher = await anzahlVorgaenge()
      const res = await senden({ ...ANFRAGE, email: 'aus@example.com' })
      assert.equal(res.status, 503)
      assert.equal(await anzahlVorgaenge(), vorher)
    } finally {
      await h.sql`update prozesse set aktiv = true where code = 'reparatur_anfrage'`
    }
  })

  test('Website-Kanal: dieselbe Funktion, unverändertes HTTP-Verhalten, Quelle kundenformular', async () => {
    const anfrage = (body: unknown) =>
      website.POST(
        new Request('https://erp.example.test/api/reparaturanfrage', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        }),
      )
    const ungueltig = await anfrage({ ...ANFRAGE, email: '' })
    assert.equal(ungueltig.status, 422)
    assert.deepEqual(await ungueltig.json(), { ok: false, fehler: { email: 'Bitte ausfüllen' } })

    const ok = await anfrage({ ...ANFRAGE, email: 'web@example.com' })
    assert.equal(ok.status, 200)
    const antwort = (await ok.json()) as { ok: boolean; nummer: string }
    assert.equal(antwort.ok, true)
    const [v] = await h.sql<{ quelle: string }[]>`select quelle from vorgaenge where number = ${antwort.nummer}`
    assert.equal(v.quelle, 'kundenformular')

    const honig = await anfrage({ ...ANFRAGE, webseite: 'x' })
    assert.deepEqual(await honig.json(), { ok: true })

    const kaputt = await website.POST(
      new Request('https://erp.example.test/api/reparaturanfrage', { method: 'POST', body: '{kein json' }),
    )
    assert.equal(kaputt.status, 400)
  })
})
