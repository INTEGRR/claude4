#!/usr/bin/env node
/**
 * Shop-Nachbau für den Lasttest — ein eigenständiges Programm, NICHT Teil
 * der App. Verhält sich an der Admin-API wie Shopify, soweit KRNL sie beim
 * Verkauf benutzt: führt je Angebot einen Bestand, zählt bei jedem Kauf
 * SOFORT herunter (nicht weiterverkaufen: bei 0 ist Schluss), nimmt
 * absolute Meldungen und Differenzen an (mit Vergleichswert und
 * Idempotenz-Schlüssel) und schickt signierte Webhooks an die App —
 * verzögert, doppelt und in vertauschter Reihenfolge, wie der echte Shop.
 *
 * Er kennt die Stücklisten (nur zum PRÜFEN): bei jedem Kauf und jeder
 * Meldung rechnet er nach, ob das Angebotene noch durch Teile gedeckt ist,
 * und protokolliert jeden Augenblick, in dem es das nicht war.
 *
 *   node lasttest/shop-nachbau.mjs            (Port 4010)
 *
 * Umgebung: NACHBAU_PORT, NACHBAU_APP (Adresse der App),
 * NACHBAU_SECRET (Webhook-Signatur = SHOPIFY_WEBHOOK_SECRET der App).
 */
import { createServer } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'

const PORT = Number(process.env.NACHBAU_PORT ?? 4010)
const APP = (process.env.NACHBAU_APP ?? 'http://127.0.0.1:3100').replace(/\/+$/, '')
const SECRET = process.env.NACHBAU_SECRET ?? 'lasttest-geheim'
const LOCATION = 'gid://shopify/Location/1'

/** Zustand — alles im Speicher, /_reset leert ihn. */
let z = neu()
function neu() {
  return {
    /** variantGid → Angebot */
    angebote: new Map(),
    /** inventoryItemGid → variantGid */
    items: new Map(),
    bestellungen: new Map(),
    schluessel: new Set(),
    /** Teile: id → { anfang, verkauft } — nur zur Prüfung */
    teile: new Map(),
    protokoll: [],
    verletzungen: [],
    zaehler: { kaeufe: 0, ausverkauft: 0, webhooks: 0, webhookFehler: 0, gedrosselt: 0, aufrufe: 0, veraltet: 0 },
    einstellung: {
      /** Webhook-Verzögerung in ms: gleichverteilt zwischen min und max. */
      verzoegerung: [50, 1500],
      /** Anteil doppelt zugestellter Webhooks. */
      doppelt: 0.1,
      /** Anteil stark verspäteter Webhooks (bis `spaet` ms). */
      spaetAnteil: 0.05,
      spaet: 8000,
      /** Drosselung: Eimer in Punkten, Auffüllung je Sekunde, Kosten je Aufruf. 0 = aus. */
      eimer: 2000, auffuellung: 100, kosten: 20,
    },
    eimerStand: 2000,
    eimerZeit: Date.now(),
    // Je Einrichtung ein eigener Nummernkreis — ein zweiter Lauf gegen dieselbe Datenbank kollidiert nicht.
    bestellNr: (Math.floor(Date.now() / 1000) % 20_000_000) * 100,
    offeneWebhooks: 0,
  }
}

const jetzt = () => new Date().toISOString()
const log = (art, daten) => z.protokoll.push({ t: Date.now(), art, ...daten })
const nr = (gid) => String(gid).split('/').pop()

/** Ist das Angebotene durch Teile gedeckt? Je Teil: Σ angeboten × je ≤ Anfang − verkauft. */
function pruefen(anlass) {
  const angeboten = new Map()
  for (const a of z.angebote.values()) {
    if (a.verfuegbar <= 0) continue
    for (const [teil, je] of a.bedarf) angeboten.set(teil, (angeboten.get(teil) ?? 0) + a.verfuegbar * je)
  }
  for (const [teil, t] of z.teile) {
    const rest = t.anfang - t.verkauft
    const an = angeboten.get(teil) ?? 0
    if (an > rest + 1e-6) {
      z.verletzungen.push({ t: Date.now(), anlass, teil, angeboten: an, rest, ueber: an - rest })
    }
    if (t.verkauft > t.anfang + 1e-6 && !t.ueberverkauftGemeldet) {
      t.ueberverkauftGemeldet = true
      log('UEBERVERKAUF', { teil, verkauft: t.verkauft, anfang: t.anfang })
    }
  }
}

function drosseln() {
  const e = z.einstellung
  if (!e.eimer) return false
  const dt = (Date.now() - z.eimerZeit) / 1000
  z.eimerStand = Math.min(e.eimer, z.eimerStand + dt * e.auffuellung)
  z.eimerZeit = Date.now()
  if (z.eimerStand < e.kosten) {
    z.zaehler.gedrosselt++
    return true
  }
  z.eimerStand -= e.kosten
  return false
}

// --- Webhooks -----------------------------------------------------------------

function webhook(topic, payload) {
  const e = z.einstellung
  const senden = (verzug) => {
    z.offeneWebhooks++
    setTimeout(async () => {
      const body = JSON.stringify(payload)
      const hmac = createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')
      try {
        const res = await fetch(`${APP}/api/webhooks/shopify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-topic': topic,
            'x-shopify-hmac-sha256': hmac,
            // Dieselbe Kennung bei einer Doppelzustellung — wie der echte Shop.
            'x-shopify-webhook-id': payload.__id,
          },
          body,
        })
        z.zaehler.webhooks++
        if (!res.ok) {
          z.zaehler.webhookFehler++
          log('webhook-fehler', { topic, status: res.status })
        }
      } catch (err) {
        z.zaehler.webhookFehler++
        log('webhook-fehler', { topic, fehler: String(err) })
      } finally {
        z.offeneWebhooks--
      }
    }, verzug)
  }
  payload.__id = randomUUID()
  const zufall = (min, max) => min + Math.random() * (max - min)
  const verzug = Math.random() < e.spaetAnteil ? zufall(e.verzoegerung[1], e.spaet) : zufall(...e.verzoegerung)
  senden(verzug)
  if (Math.random() < e.doppelt) senden(verzug + zufall(100, 2000))
}

function bestandsWebhook(a) {
  webhook('inventory_levels/update', {
    inventory_item_id: Number(nr(a.item)), location_id: 1, available: a.verfuegbar, updated_at: jetzt(),
  })
}

// --- Kauf ----------------------------------------------------------------------

function kaufen(variantGid, menge) {
  const a = z.angebote.get(variantGid)
  if (!a) return { ok: false, grund: 'unbekannt' }
  // Nicht weiterverkaufen: bei zu wenig Bestand ist Schluss. Ohne
  // Mengenverfolgung (noch nicht eingerichtet) verkauft der Shop immer.
  if (a.tracked && a.policy === 'DENY' && a.verfuegbar < menge) {
    z.zaehler.ausverkauft++
    return { ok: false, grund: 'ausverkauft' }
  }
  a.verfuegbar -= menge
  z.zaehler.kaeufe++
  for (const [teil, je] of a.bedarf) z.teile.get(teil).verkauft += menge * je
  const id = ++z.bestellNr
  const gid = `gid://shopify/Order/${id}`
  const zeit = jetzt()
  const preis = '149.00'
  z.bestellungen.set(gid, {
    id: gid, name: `#L${id}`, createdAt: zeit, updatedAt: zeit, taxesIncluded: true,
    email: `kunde${id}@example.com`, tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    fulfillments: [], cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: preis, currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: preis } },
    totalOutstandingSet: { shopMoney: { amount: '0.00' } },
    customer: { id: `gid://shopify/Customer/${id % 97}`, firstName: 'Last', lastName: `Test ${id % 97}`, defaultEmailAddress: { emailAddress: `kunde${id % 97}@example.com` } },
    shippingAddress: { name: `Last Test ${id % 97}`, address1: 'Teststraße 1', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE', phone: null },
    billingAddress: { name: `Last Test ${id % 97}`, company: null, address1: 'Teststraße 1', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE' },
    paymentGatewayNames: ['shopify_payments'],
    shippingLine: { discountedPriceSet: { shopMoney: { amount: '0.00' } }, taxLines: [] },
    lineItems: { nodes: [{
      id: `gid://shopify/LineItem/${id}`, title: a.titel, variantTitle: null, sku: a.sku,
      currentQuantity: menge, quantity: menge, variant: { id: variantGid },
      originalUnitPriceSet: { shopMoney: { amount: preis } },
      discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: preis } },
      taxLines: [{ rate: 0.19 }],
    }] },
  })
  log('kauf', { bestellung: gid, angebot: variantGid, sku: a.sku, menge, danach: a.verfuegbar })
  pruefen(`Kauf ${a.sku}`)
  // Wie der echte Shop: zu jedem Kauf mehrere Ereignisse gleichzeitig.
  const kopf = { id, admin_graphql_api_id: gid, updated_at: zeit }
  webhook('orders/create', { ...kopf })
  webhook('orders/updated', { ...kopf })
  bestandsWebhook(a)
  return { ok: true, bestellung: gid, danach: a.verfuegbar }
}

// --- GraphQL ---------------------------------------------------------------------

function operation(query) {
  return query.match(/^\s*(?:query|mutation)?\s*(?:\w+\s*)?\(?[^{]*\{\s*(\w+)/)?.[1] ?? 'unbekannt'
}

function graphql(query, v) {
  const op = operation(query)
  z.zaehler.aufrufe++
  const fehlt = (feld) => !('changeFromQuantity' in feld)
  switch (op) {
    case 'order': {
      const o = z.bestellungen.get(String(v.id)) ?? null
      if (query.includes('fulfillmentHolds')) {
        return { order: o && { displayFulfillmentStatus: o.displayFulfillmentStatus, displayFinancialStatus: o.displayFinancialStatus,
          fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', fulfillmentHolds: [] }] } } }
      }
      return { order: o }
    }
    case 'locations':
      return { locations: { nodes: [{ id: LOCATION, name: 'Lager', isActive: true }] } }
    case 'nodes':
      // Stapelabruf von Bestellungen (fetchOrders).
      if ((v.ids ?? []).some((id) => String(id).includes('/Order/'))) {
        return { nodes: (v.ids ?? []).map((id) => z.bestellungen.get(String(id)) ?? null) }
      }
      return {
        nodes: (v.ids ?? []).map((id) => {
          const a = z.angebote.get(id)
          if (!a) return null
          return {
            id, inventoryQuantity: a.verfuegbar, inventoryPolicy: a.policy,
            product: { id: a.produkt }, inventoryItem: { id: a.item, tracked: a.tracked },
          }
        }),
      }
    case 'productVariantsBulkUpdate': {
      for (const e of v.variants ?? []) {
        const a = z.angebote.get(e.id)
        if (!a) continue
        if (e.inventoryPolicy) a.policy = e.inventoryPolicy
        if (e.inventoryItem?.tracked !== undefined) a.tracked = e.inventoryItem.tracked
      }
      log('einrichten', { anzahl: (v.variants ?? []).length })
      return { productVariantsBulkUpdate: { userErrors: [] } }
    }
    case 'inventorySetQuantities': {
      const mengen = v.input?.quantities ?? []
      if (mengen.some(fehlt)) throw new Error('InventoryQuantityInput must include the following argument: changeFromQuantity.')
      if (!/@idempotent\s*\(/.test(query) || typeof v.idempotencyKey !== 'string') throw new Error('The @idempotent directive is required for this mutation but was not provided.')
      if (z.schluessel.has(v.idempotencyKey)) return { inventorySetQuantities: { userErrors: [] } }
      const userErrors = mengen.flatMap((q, i) => (z.items.has(q.inventoryItemId) ? [] : [{ field: ['input', 'quantities', String(i), 'inventoryItemId'], message: 'The specified inventory item could not be found.' }]))
      if (userErrors.length === 0) {
        z.schluessel.add(v.idempotencyKey)
        for (const q of mengen) {
          const a = z.angebote.get(z.items.get(q.inventoryItemId))
          const vorher = a.verfuegbar
          a.verfuegbar = q.quantity
          log('absolut', { sku: a.sku, vorher, danach: a.verfuegbar })
          if (vorher !== a.verfuegbar) bestandsWebhook(a)
        }
        pruefen('absolute Meldung')
      }
      return { inventorySetQuantities: { userErrors } }
    }
    case 'inventoryAdjustQuantities': {
      const aenderungen = v.input?.changes ?? []
      if (aenderungen.some(fehlt)) throw new Error('InventoryChangeInput must include the following argument: changeFromQuantity.')
      if (!/@idempotent\s*\(/.test(query) || typeof v.idempotencyKey !== 'string') throw new Error('The @idempotent directive is required for this mutation but was not provided.')
      if (z.schluessel.has(v.idempotencyKey)) return { inventoryAdjustQuantities: { userErrors: [] } }
      const userErrors = aenderungen.flatMap((q, i) => {
        const a = z.angebote.get(z.items.get(q.inventoryItemId))
        if (!a) return [{ field: ['input', 'changes', String(i), 'inventoryItemId'], message: 'The specified inventory item could not be found.', code: 'ITEM_NOT_FOUND' }]
        if (typeof q.changeFromQuantity === 'number' && a.verfuegbar !== q.changeFromQuantity) {
          z.zaehler.veraltet++
          return [{ field: ['input', 'changes', String(i), 'changeFromQuantity'], message: 'The quantity has changed since it was last read.', code: 'CHANGE_FROM_QUANTITY_STALE' }]
        }
        return []
      })
      if (userErrors.length === 0) {
        z.schluessel.add(v.idempotencyKey)
        for (const q of aenderungen) {
          const a = z.angebote.get(z.items.get(q.inventoryItemId))
          const vorher = a.verfuegbar
          a.verfuegbar += q.delta
          log('differenz', { sku: a.sku, delta: q.delta, vorher, danach: a.verfuegbar, vergleich: q.changeFromQuantity })
          bestandsWebhook(a)
        }
        pruefen('Differenz-Meldung')
      }
      return { inventoryAdjustQuantities: { userErrors } }
    }
    case 'productVariants':
      return {
        productVariants: {
          nodes: [...z.angebote.entries()].map(([id, a]) => ({
            id, sku: a.sku, barcode: null, inventoryQuantity: a.verfuegbar, inventoryPolicy: a.policy,
            availableForSale: !a.tracked || a.policy !== 'DENY' || a.verfuegbar > 0,
            product: { id: a.produkt, title: a.titel, status: 'ACTIVE', hasVariantsThatRequiresComponents: false },
            inventoryItem: { id: a.item, tracked: a.tracked },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }
    case 'orders':
      return { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
    case 'webhookSubscriptions':
      return { webhookSubscriptions: { nodes: [] } }
    default:
      log('unbekannte-operation', { op })
      throw new Error(`Shop-Nachbau: Operation „${op}" ist nicht nachgebaut`)
  }
}

// --- HTTP ----------------------------------------------------------------------

async function koerper(req) {
  const teile = []
  for await (const c of req) teile.push(c)
  const text = Buffer.concat(teile).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const antwort = (res, status, daten) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(daten))
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (req.method === 'POST' && /\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) {
      const { query, variables } = await koerper(req)
      if (drosseln()) {
        return antwort(res, 200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })
      }
      try {
        return antwort(res, 200, { data: graphql(query, variables ?? {}) })
      } catch (err) {
        return antwort(res, 200, { errors: [{ message: String(err.message ?? err) }] })
      }
    }
    if (req.method === 'POST' && url.pathname === '/_kauf') {
      const { variantGid, menge } = await koerper(req)
      return antwort(res, 200, kaufen(variantGid, menge ?? 1))
    }
    if (req.method === 'POST' && url.pathname === '/_einrichten') {
      // { teile: [{id, anfang}], angebote: [{gid, item, produkt, sku, titel, bedarf: [[teil, je]], verfuegbar?}], einstellung? }
      const k = await koerper(req)
      z = neu()
      Object.assign(z.einstellung, k.einstellung ?? {})
      z.eimerStand = z.einstellung.eimer
      for (const t of k.teile ?? []) z.teile.set(t.id, { anfang: t.anfang, verkauft: 0 })
      for (const a of k.angebote ?? []) {
        // Tastaturen wie bei ANVIL vor der Einrichtung: ohne Mengenverfolgung, „weiterverkaufen" —
        // KRNL stellt sie um. Lagerartikel wie im Shop üblich: Menge verfolgt, nicht weiterverkaufen.
        z.angebote.set(a.gid, {
          ...a, verfuegbar: a.verfuegbar ?? 0,
          tracked: Boolean(a.lagerartikel), policy: a.lagerartikel ? 'DENY' : 'CONTINUE',
        })
        z.items.set(a.item, a.gid)
      }
      return antwort(res, 200, { ok: true, angebote: z.angebote.size, teile: z.teile.size })
    }
    if (req.method === 'POST' && url.pathname === '/_einstellung') {
      Object.assign(z.einstellung, await koerper(req))
      return antwort(res, 200, z.einstellung)
    }
    if (req.method === 'GET' && url.pathname === '/_stand') {
      return antwort(res, 200, {
        zaehler: z.zaehler, offeneWebhooks: z.offeneWebhooks, bestellungen: z.bestellungen.size,
        angebote: [...z.angebote.entries()].map(([gid, a]) => ({ gid, sku: a.sku, verfuegbar: a.verfuegbar, tracked: a.tracked, policy: a.policy })),
        teile: [...z.teile.entries()].map(([id, t]) => ({ id, ...t })),
        verletzungen: z.verletzungen.length,
      })
    }
    if (req.method === 'GET' && url.pathname === '/_protokoll') {
      return antwort(res, 200, { protokoll: z.protokoll, verletzungen: z.verletzungen })
    }
    antwort(res, 404, { fehler: 'unbekannt' })
  } catch (err) {
    antwort(res, 500, { fehler: String(err) })
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Shop-Nachbau auf http://127.0.0.1:${PORT} → Webhooks an ${APP}`)
})
