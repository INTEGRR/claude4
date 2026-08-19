import { sql } from '@/db/client'
import { ShopifyError, shopifyGraphQL } from './shopify'
import {
  type VarianteMitBestand,
  bestandsInput,
  deuteInventarPayload,
  inBloecken,
  zuUebertragen,
} from './inventar-logik'

/**
 * Bestandsabgleich mit Shopify.
 *
 * Das ERP ist die Quelle der Wahrheit: gemeldet wird die frei verfügbare
 * Menge (free_to_use — Bestand minus Reservierungen an internen Orten).
 * Der Abgleich läuft über die Outbox (Job `shopify_inventory_push`), wird
 * viertelstündlich vom Reconcile-Cron angestoßen und zusätzlich, sobald der
 * Webhook inventory_levels/update eine Abweichung zeigt.
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
  const varianten = await sql<VarianteMitBestand[]>`
    select v.id as variant_id, v.sku,
           v.shopify_inventory_item_gid as inventory_item_gid,
           free_to_use(v.id) as frei,
           s.pushed_qty
    from product_variants v
    left join shopify_inventory_state s on s.variant_id = v.id
    where v.shopify_variant_id is not null and v.active
    order by v.sku`

  if (varianten.length === 0) return { geprueft: 0, uebertragen: 0, ohneZuordnung: 0 }

  await ergaenzeInventoryItems(varianten)
  const { melden, ohneZuordnung } = zuUebertragen(varianten)
  if (melden.length === 0) {
    return { geprueft: varianten.length, uebertragen: 0, ohneZuordnung: ohneZuordnung.length }
  }

  const location = await locationGid()

  for (const block of inBloecken(melden, 200)) {
    const data = await shopifyGraphQL<{
      inventorySetQuantities: { userErrors: { field: string[] | null; message: string }[] }
    }>(
      `mutation bestand($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) { userErrors { field message } }
       }`,
      // changeFromQuantity: null je Position — Pflichtfeld seit 2026-07,
      // null heißt „nicht vergleichen": das ERP ist die Quelle der Wahrheit
      // (Details am Builder in inventar-logik.ts).
      { input: bestandsInput(block, location) },
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
    select id, sku, free_to_use(id) as frei
    from product_variants
    where shopify_inventory_item_gid = ${meldung.inventoryItemGid}`
  if (!variante) return 'InventoryItem keiner Variante zugeordnet — übersprungen'

  await sql`
    insert into shopify_inventory_state (variant_id, shop_qty, shop_seen_at)
    values (${variante.id}, ${meldung.verfuegbar}, now())
    on conflict (variant_id) do update
      set shop_qty = excluded.shop_qty, shop_seen_at = now()`

  if (meldung.verfuegbar !== Math.floor(variante.frei)) {
    // Nicht selbst pushen (Webhooks kommen in Wellen) — ein Job mit
    // Dedupe-Schlüssel bündelt beliebig viele Abweichungen zu einem Abgleich.
    await sql`select enqueue_job('shopify_inventory_push', '{}'::jsonb, 'inventar-abgleich')`
    return `Abweichung bei ${variante.sku ?? variante.id}: Shop ${meldung.verfuegbar}, ERP ${variante.frei} — Abgleich eingereiht`
  }
  return `Stand bestätigt (${variante.sku ?? variante.id}: ${meldung.verfuegbar})`
}
