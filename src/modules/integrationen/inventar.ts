import { randomUUID } from 'node:crypto'
import { sql } from '@/db/client'
import { ShopifyError, shopifyGraphQL } from './shopify'
import {
  INVENTAR_MUTATION,
  type VarianteMitBestand,
  bestandsInput,
  deuteInventarPayload,
  inBloecken,
  zuUebertragen,
} from './inventar-logik'

/**
 * Bestandsabgleich mit Shopify.
 *
 * Das ERP ist die Quelle der Wahrheit: gemeldet wird shopify_soll_menge()
 * (0100) — für normale Artikel die frei verfügbare Menge (Bestand minus
 * Reservierungen an internen Orten), für Made-to-Order-Tastaturen die
 * BAUBARE Menge aus freiem Material laut Stückliste (mit Puffer und Deckel).
 *
 * Schnell, weil es bei Releases und Aktionen darauf ankommt
 * (Entscheidungslog 2026-10-01): jede importierte Shopify-Bestellung stößt
 * den Abgleich an (inventar_abgleich_anstossen), der Webhook arbeitet ihn
 * direkt nach der Antwort ab — Sekunden statt Minuten. Dazu jede Minute
 * (Änderungen in KRNL: Wareneingang, Inventur, Fertigmeldung) und
 * viertelstündlich als Sicherheitsnetz. Läuft schon ein Abgleich, rechnet er
 * am Ende eine weitere Runde, statt den Anstoß zu verlieren.
 */

// --- Standort ----------------------------------------------------------------

/**
 * Shopify bucht Bestände je Standort. Wir führen einen: den ersten aktiven
 * des Shops. Die Wahl wird gespeichert, damit sie stabil bleibt, auch wenn
 * später Standorte dazukommen.
 */
async function locationGid(): Promise<string> {
  const [row] = await sql<{ value: { gid?: string } }[]>`
    select value from shopify_sync_state where key = 'inventory_location'`
  if (row?.value?.gid) return row.value.gid

  const data = await shopifyGraphQL<{
    locations: { nodes: { id: string; name: string; isActive: boolean }[] }
  }>(`query { locations(first: 10) { nodes { id name isActive } } }`)

  const aktiv = data.locations.nodes.find((l) => l.isActive) ?? data.locations.nodes[0]
  if (!aktiv) throw new ShopifyError('Shopify meldet keinen Standort', false)

  await sql`
    insert into shopify_sync_state (key, value)
    values ('inventory_location', ${sql.json({ gid: aktiv.id, name: aktiv.name })})
    on conflict (key) do update set value = excluded.value, updated_at = now()`
  return aktiv.id
}

// --- InventoryItem-Zuordnung ---------------------------------------------------

/**
 * Shopify adressiert Bestand über das InventoryItem der Variante, nicht über
 * die Variante selbst. Die Zuordnung ändert sich nie — einmal erfragen, an
 * der Variante speichern.
 */
async function ergaenzeInventoryItems(varianten: VarianteMitBestand[]): Promise<number> {
  const offen = varianten.filter((v) => !v.inventory_item_gid)
  if (offen.length === 0) return 0

  const gids = await sql<{ id: string; gid: string }[]>`
    select id, shopify_variant_id as gid from product_variants
    where id in ${sql(offen.map((v) => v.variant_id))}`
  const varianteZuGid = new Map(gids.map((r) => [r.gid, r.id]))

  let ergaenzt = 0
  for (const block of inBloecken([...varianteZuGid.keys()], 100)) {
    const data = await shopifyGraphQL<{
      nodes: ({ id: string; inventoryItem: { id: string } | null } | null)[]
    }>(
      `query varianten($ids: [ID!]!) {
         nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } }
       }`,
      { ids: block },
    )
    for (const node of data.nodes) {
      if (!node?.inventoryItem) continue
      const variantId = varianteZuGid.get(node.id)
      if (!variantId) continue
      await sql`update product_variants
                set shopify_inventory_item_gid = ${node.inventoryItem.id}
                where id = ${variantId} and shopify_inventory_item_gid is null`
      const betroffen = varianten.find((v) => v.variant_id === variantId)
      if (betroffen) betroffen.inventory_item_gid = node.inventoryItem.id
      ergaenzt++
    }
  }
  return ergaenzt
}

// --- Push ----------------------------------------------------------------------

export interface PushErgebnis {
  geprueft: number
  uebertragen: number
  ohneZuordnung: number
}

/**
 * Meldet die verfügbare Menge aller Shopify-gekoppelten Varianten an den
 * Shop. Übertragen wird nur, was sich seit der letzten Meldung geändert hat —
 * ein leerer Durchlauf kostet keinen einzigen API-Aufruf.
 */
export async function pushInventar(): Promise<PushErgebnis> {
  const varianten = await sql<(VarianteMitBestand & { mto: boolean; eingerichtet: boolean })[]>`
    select v.id as variant_id, v.sku,
           v.shopify_inventory_item_gid as inventory_item_gid,
           shopify_soll_menge(v.id) as frei,
           s.pushed_qty,
           ist_made_to_order(v.id) as mto,
           s.mto_eingerichtet_at is not null as eingerichtet
    from product_variants v
    left join shopify_inventory_state s on s.variant_id = v.id
    where v.shopify_variant_id is not null and v.active
    order by v.sku`

  if (varianten.length === 0) return { geprueft: 0, uebertragen: 0, ohneZuordnung: 0 }

  await ergaenzeInventoryItems(varianten)
  await madeToOrderEinrichten(varianten.filter((v) => v.mto && !v.eingerichtet))
  const { melden, ohneZuordnung } = zuUebertragen(varianten)
  if (melden.length === 0) {
    return { geprueft: varianten.length, uebertragen: 0, ohneZuordnung: ohneZuordnung.length }
  }

  const location = await locationGid()

  for (const block of inBloecken(melden, 200)) {
    const data = await shopifyGraphQL<{
      inventorySetQuantities: { userErrors: { field: string[] | null; message: string }[] }
    }>(
      // changeFromQuantity: null je Position (Pflichtfeld, null = nicht
      // vergleichen — das ERP ist die Quelle der Wahrheit) und @idempotent
      // mit frischem Schlüssel je Aufruf; Details in inventar-logik.ts.
      INVENTAR_MUTATION,
      { input: bestandsInput(block, location), idempotencyKey: randomUUID() },
    )
    const fehler = data.inventorySetQuantities.userErrors
    if (fehler.length > 0) {
      throw new ShopifyError(
        `Bestandsmeldung abgelehnt: ${fehler.map((f) => f.message).join('; ')}`,
        false,
      )
    }
    for (const v of block) {
      await sql`
        insert into shopify_inventory_state (variant_id, pushed_qty, pushed_at, shop_qty, shop_seen_at)
        values (${v.variant_id}, ${v.frei}, now(), ${Math.floor(v.frei)}, now())
        on conflict (variant_id) do update
          set pushed_qty = excluded.pushed_qty, pushed_at = now(),
              shop_qty = excluded.shop_qty, shop_seen_at = now()`
    }
  }

  return {
    geprueft: varianten.length,
    uebertragen: melden.length,
    ohneZuordnung: ohneZuordnung.length,
  }
}

// --- Made-to-Order in Shopify einrichten ----------------------------------------

/**
 * Für Tastaturen hatte Shopify keinen Bestandsabgleich (keine
 * Mengenverfolgung, Verkauf ohne Bestand). Damit die gemeldete baubare
 * Menge wirkt und 0 wirklich „ausverkauft" heißt, wird jede
 * Made-to-Order-Variante einmal umgestellt: Menge verfolgen an,
 * inventoryPolicy DENY. Danach gemerkt (mto_eingerichtet_at).
 */
async function madeToOrderEinrichten(varianten: { variant_id: string }[]): Promise<number> {
  if (varianten.length === 0) return 0
  const gids = await sql<{ id: string; gid: string }[]>`
    select id, shopify_variant_id as gid from product_variants
    where id in ${sql(varianten.map((v) => v.variant_id))}`
  const varianteZuGid = new Map(gids.map((r) => [r.gid, r.id]))

  const jeProdukt = new Map<string, string[]>()
  const fertig: string[] = []
  for (const block of inBloecken([...varianteZuGid.keys()], 100)) {
    const data = await shopifyGraphQL<{
      nodes: ({
        id: string
        inventoryPolicy: string
        product: { id: string }
        inventoryItem: { tracked: boolean } | null
      } | null)[]
    }>(
      `query mtoStand($ids: [ID!]!) {
         nodes(ids: $ids) { ... on ProductVariant { id inventoryPolicy product { id } inventoryItem { tracked } } }
       }`,
      { ids: block },
    )
    for (const node of data.nodes) {
      if (!node) continue
      const variantId = varianteZuGid.get(node.id)
      if (!variantId) continue
      if (node.inventoryPolicy === 'DENY' && node.inventoryItem?.tracked) {
        fertig.push(variantId)
        continue
      }
      jeProdukt.set(node.product.id, [...(jeProdukt.get(node.product.id) ?? []), node.id])
    }
  }

  for (const [productId, ids] of jeProdukt) {
    const data = await shopifyGraphQL<{
      productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] }
    }>(
      `mutation mtoEinrichten($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
       }`,
      {
        productId,
        variants: ids.map((id) => ({ id, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } })),
      },
    )
    const fehler = data.productVariantsBulkUpdate.userErrors
    if (fehler.length > 0) {
      throw new ShopifyError(`Made-to-Order-Einrichtung abgelehnt: ${fehler.map((f) => f.message).join('; ')}`, false)
    }
    for (const gid of ids) fertig.push(varianteZuGid.get(gid)!)
  }

  for (const variantId of fertig) {
    await sql`
      insert into shopify_inventory_state (variant_id, mto_eingerichtet_at) values (${variantId}, now())
      on conflict (variant_id) do update set mto_eingerichtet_at = now()`
  }
  return fertig.length
}

// --- Abgleich mit Sperre und Nachlauf ---------------------------------------------

const SPERRE_SEKUNDEN = 90

async function anstossZaehler(): Promise<number> {
  const [row] = await sql<{ n: string | null }[]>`
    select value ->> 'n' as n from shopify_sync_state where key = 'inventar_anstoss'`
  return Number(row?.n ?? 0)
}

/**
 * Ein Abgleich zur Zeit (Sperre mit Ablauf, falls ein Lauf abstürzt). Wer die
 * Sperre nicht bekommt, kehrt sofort zurück — der laufende Abgleich sieht
 * den Anstoß am Zähler und rechnet eine weitere Runde (höchstens fünf).
 */
export async function inventarAbgleichen(): Promise<PushErgebnis & { runden: number; gesperrt: boolean }> {
  const gesperrt = await sql`
    insert into shopify_sync_state (key, value)
    values ('inventar_sperre', jsonb_build_object('bis', now() + make_interval(secs => ${SPERRE_SEKUNDEN})))
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (shopify_sync_state.value ->> 'bis')::timestamptz < now()
    returning key`
  if (gesperrt.length === 0) return { geprueft: 0, uebertragen: 0, ohneZuordnung: 0, runden: 0, gesperrt: true }

  const gesamt = { geprueft: 0, uebertragen: 0, ohneZuordnung: 0, runden: 0, gesperrt: false }
  try {
    let vorher: number
    do {
      vorher = await anstossZaehler()
      const r = await pushInventar()
      gesamt.geprueft = r.geprueft
      gesamt.uebertragen += r.uebertragen
      gesamt.ohneZuordnung = r.ohneZuordnung
      gesamt.runden++
    } while ((await anstossZaehler()) !== vorher && gesamt.runden < 5)
  } finally {
    await sql`
      update shopify_sync_state set value = jsonb_build_object('bis', now()), updated_at = now()
      where key = 'inventar_sperre'`
  }
  return gesamt
}

// --- Shop-Stand lesen (Ist) ------------------------------------------------------

/**
 * Liest je Shopify-Variante Menge, availableForSale, Mengenverfolgung,
 * inventoryPolicy und Produktstatus — nur Queries, darum auch im Modus
 * „nur lesen". Grundlage für den Vergleich Ist (Shop) gegen Soll (KRNL) in
 * der Shop-Verfügbarkeit; läuft von Hand und viertelstündlich im Reconcile.
 */
export async function shopStandHolen(): Promise<{ varianten: number; verkaufbar: number; zugeordnet: number }> {
  const ergebnis = { varianten: 0, verkaufbar: 0, zugeordnet: 0 }
  let after: string | null = null
  for (let seite = 0; seite < 40; seite++) {
    const data: {
      productVariants: {
        nodes: {
          id: string
          inventoryQuantity: number | null
          inventoryPolicy: string
          availableForSale: boolean
          product: { status: string }
          inventoryItem: { id: string; tracked: boolean } | null
        }[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } = await shopifyGraphQL(
      `query shopStand($after: String) {
         productVariants(first: 250, after: $after) {
           nodes { id inventoryQuantity inventoryPolicy availableForSale product { status } inventoryItem { id tracked } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { after },
    )
    for (const n of data.productVariants.nodes) {
      ergebnis.varianten++
      if (n.availableForSale) ergebnis.verkaufbar++
      const [v] = await sql<{ id: string }[]>`
        update product_variants
        set shopify_inventory_item_gid = coalesce(shopify_inventory_item_gid, ${n.inventoryItem?.id ?? null})
        where shopify_variant_id = ${n.id}
        returning id`
      if (!v) continue
      ergebnis.zugeordnet++
      await sql`
        insert into shopify_inventory_state
          (variant_id, shop_qty, shop_seen_at, shop_verkaufbar, shop_tracked, shop_policy, shop_status)
        values (${v.id}, ${n.inventoryQuantity}, now(), ${n.availableForSale}, ${n.inventoryItem?.tracked ?? null},
                ${n.inventoryPolicy}, ${n.product.status})
        on conflict (variant_id) do update set
          shop_qty = excluded.shop_qty, shop_seen_at = now(), shop_verkaufbar = excluded.shop_verkaufbar,
          shop_tracked = excluded.shop_tracked, shop_policy = excluded.shop_policy, shop_status = excluded.shop_status`
    }
    if (!data.productVariants.pageInfo.hasNextPage) break
    after = data.productVariants.pageInfo.endCursor
  }
  return ergebnis
}

// --- Webhook -------------------------------------------------------------------

/**
 * Verarbeitet inventory_levels/update: der Shop berichtet seinen Stand.
 * Weicht er vom ERP ab (jemand hat im Shopify-Admin von Hand gebucht),
 * wird ein korrigierender Push eingereiht — das ERP behält recht.
 */
export async function verarbeiteInventarWebhook(
  payload: Record<string, unknown>,
): Promise<string> {
  const meldung = deuteInventarPayload(payload)
  if (!meldung) return 'Kein verwertbarer Bestands-Payload — übersprungen'

  const [variante] = await sql<{ id: string; sku: string | null; frei: number }[]>`
    select id, sku, shopify_soll_menge(id) as frei
    from product_variants
    where shopify_inventory_item_gid = ${meldung.inventoryItemGid}`
  if (!variante) return 'InventoryItem keiner Variante zugeordnet — übersprungen'

  await sql`
    insert into shopify_inventory_state (variant_id, shop_qty, shop_seen_at)
    values (${variante.id}, ${meldung.verfuegbar}, now())
    on conflict (variant_id) do update
      set shop_qty = excluded.shop_qty, shop_seen_at = now()`

  const soll = Math.floor(variante.frei)
  if (meldung.verfuegbar > soll) {
    // Shop bietet mehr an als das ERP hergibt — sofort korrigieren. Nicht
    // selbst pushen (Webhooks kommen in Wellen): der Anstoß bündelt.
    await sql`select inventar_abgleich_anstossen()`
    return `Abweichung bei ${variante.sku ?? variante.id}: Shop ${meldung.verfuegbar}, ERP ${soll} — Abgleich angestoßen`
  }
  if (meldung.verfuegbar < soll) {
    // Shop zeigt weniger: meist hat Shopify eine Bestellung abgezogen, die
    // das ERP noch nicht importiert hat. NICHT sofort hochsetzen (das würde
    // die Bestellung überschreiben, Überverkauf!) — nur den Shop-Stand als
    // gemeldet merken; der nächste reguläre Abgleich (nach dem Import bzw.
    // minütlich) setzt die richtige Menge.
    await sql`
      update shopify_inventory_state set pushed_qty = ${meldung.verfuegbar}
      where variant_id = ${variante.id}`
    return `Shop niedriger bei ${variante.sku ?? variante.id}: Shop ${meldung.verfuegbar}, ERP ${soll} — wird beim nächsten Abgleich gesetzt`
  }
  return `Stand bestätigt (${variante.sku ?? variante.id}: ${meldung.verfuegbar})`
}
