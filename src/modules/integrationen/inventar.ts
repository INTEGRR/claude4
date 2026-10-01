import { randomUUID } from 'node:crypto'
import { sql } from '@/db/client'
import { ShopifyError, shopifyGraphQL } from './shopify'
import {
  type AngebotMitBestand,
  INVENTAR_MUTATION,
  type VarianteMitBestand,
  angeboteZuMelden,
  bestandsInput,
  deuteInventarPayload,
  fehlerJePosition,
  inBloecken,
  zuUebertragen,
} from './inventar-logik'
import { zweitangebotMerken } from './zweitangebote'

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
  /** Zweitangebote (0106): geprüft, gemeldet, von Shopify abgelehnt. */
  angebote: number
  angeboteUebertragen: number
  angeboteAbgelehnt: number
}

type VarianteZeile = VarianteMitBestand & ProbeFelder & { mto: boolean; eingerichtet: boolean }
type AngebotZeile = AngebotMitBestand & ProbeFelder & { shopify_variant_id: string; eingerichtet: boolean }

/**
 * Zweitangebote mit Soll-Menge (0106) — ohne Angebote, die inzwischen selbst
 * verknüpftes Angebot eines Artikels sind (die meldet der normale Weg).
 */
async function zweitangeboteLaden(): Promise<AngebotZeile[]> {
  return sql<AngebotZeile[]>`
    select z.id as angebot_id, z.variant_id, coalesce(z.sku, v.sku) as sku,
           v.display_name as name, coalesce(z.produkt, 'Zweitangebot') as produkt,
           z.shopify_variant_id,
           z.shopify_inventory_item_gid as inventory_item_gid,
           shopify_soll_menge_zweitangebot(z.id) as frei,
           z.pushed_qty, z.push_fehler_qty,
           ist_made_to_order(z.variant_id) as mto,
           z.mto_eingerichtet_at is not null as eingerichtet,
           z.probe_qty,
           z.probe_eingerichtet_at is not null as probe_eingerichtet
    from shopify_zweitangebote z
    join product_variants v on v.id = z.variant_id
    where v.active
      and not exists (select 1 from product_variants x where x.shopify_variant_id = z.shopify_variant_id)
    order by v.sku, z.produkt`
}

/**
 * Meldet die verfügbare Menge aller Shopify-gekoppelten Varianten an den
 * Shop — und dieselbe Menge an ihre Zweitangebote (0106: Bundle-Bestandteile,
 * Aktions-Editionen mit derselben SKU). Übertragen wird nur, was sich seit
 * der letzten Meldung geändert hat — ein leerer Durchlauf kostet keinen
 * einzigen API-Aufruf.
 */
export async function pushInventar(): Promise<PushErgebnis> {
  const varianten = await sql<VarianteZeile[]>`
    select v.id as variant_id, v.sku, v.display_name as name,
           v.shopify_inventory_item_gid as inventory_item_gid,
           shopify_soll_menge(v.id) as frei,
           s.pushed_qty,
           ist_made_to_order(v.id) as mto,
           s.mto_eingerichtet_at is not null as eingerichtet,
           s.probe_qty,
           s.probe_eingerichtet_at is not null as probe_eingerichtet
    from product_variants v
    left join shopify_inventory_state s on s.variant_id = v.id
    where v.shopify_variant_id is not null and v.active
    order by v.sku`
  const angebote = await zweitangeboteLaden()

  const leer = { geprueft: 0, uebertragen: 0, ohneZuordnung: 0, angebote: 0, angeboteUebertragen: 0, angeboteAbgelehnt: 0 }
  if (varianten.length === 0 && angebote.length === 0) return leer

  // Probelauf (0102): rechnen wie scharf, aber nichts senden — nur
  // protokollieren, was gemeldet würde, gegen den eigenen Probe-Stand.
  const { shopifyModus } = await import('./shopify-modus')
  if ((await shopifyModus(sql)) === 'probe') return probeInventar(varianten, angebote)

  await ergaenzeInventoryItems(varianten)
  await ergaenzeAngebotItems(angebote)
  await madeToOrderEinrichten(
    varianten.filter((v) => v.mto && !v.eingerichtet),
    angebote.filter((a) => a.mto && !a.eingerichtet),
  )
  const { melden, ohneZuordnung } = zuUebertragen(varianten)
  const zweit = angeboteZuMelden(angebote)
  const ergebnis = {
    geprueft: varianten.length,
    uebertragen: melden.length,
    ohneZuordnung: ohneZuordnung.length + zweit.ohneZuordnung.length,
    angebote: angebote.length,
    angeboteUebertragen: 0,
    angeboteAbgelehnt: 0,
  }
  if (melden.length === 0 && zweit.melden.length === 0) return ergebnis

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

  const r = await angeboteMelden(zweit.melden, location)
  return { ...ergebnis, angeboteUebertragen: r.gemeldet, angeboteAbgelehnt: r.abgelehnt }
}

/**
 * Zweitangebote melden — als EIGENE Mutation nach der Hauptmeldung, damit
 * ein Angebot, das Shopify ablehnt (z. B. nicht am Standort geführt), nie den
 * Bestand der Artikel blockiert. Lehnt Shopify Positionen ab, gilt die ganze
 * Mutation als nicht ausgeführt: die genannten Angebote werden mit Grund
 * vermerkt (push_fehler) und der Rest einmal ohne sie wiederholt.
 */
async function angeboteMelden(
  melden: AngebotZeile[],
  location: string,
): Promise<{ gemeldet: number; abgelehnt: number }> {
  let gemeldet = 0
  let abgelehnt = 0
  for (const block of inBloecken(melden, 200)) {
    let offen = block
    for (let versuch = 0; versuch < 2 && offen.length > 0; versuch++) {
      const data = await shopifyGraphQL<{
        inventorySetQuantities: { userErrors: { field: string[] | null; message: string }[] }
      }>(INVENTAR_MUTATION, { input: bestandsInput(offen, location), idempotencyKey: randomUUID() })
      const fehler = data.inventorySetQuantities.userErrors
      if (fehler.length === 0) {
        for (const a of offen) {
          await sql`
            update shopify_zweitangebote
            set pushed_qty = ${a.frei}, pushed_at = now(), shop_qty = ${Math.floor(a.frei)}, shop_seen_at = now(),
                push_fehler = null, push_fehler_qty = null
            where id = ${a.angebot_id}`
        }
        gemeldet += offen.length
        break
      }
      const jePosition = fehlerJePosition(offen.length, fehler)
      for (const [i, grund] of jePosition) {
        await sql`
          update shopify_zweitangebote
          set push_fehler = ${grund.slice(0, 500)}, push_fehler_qty = ${offen[i].frei}
          where id = ${offen[i].angebot_id}`
      }
      abgelehnt += jePosition.size
      offen = offen.filter((_, i) => !jePosition.has(i))
    }
  }
  return { gemeldet, abgelehnt }
}

/** InventoryItems der Zweitangebote nachholen (fehlt, wenn der Shop-Stand sie nicht lieferte). */
async function ergaenzeAngebotItems(angebote: AngebotZeile[]): Promise<void> {
  const offen = angebote.filter((a) => !a.inventory_item_gid)
  for (const block of inBloecken(offen, 100)) {
    const data = await shopifyGraphQL<{
      nodes: ({ id: string; inventoryItem: { id: string } | null } | null)[]
    }>(
      `query varianten($ids: [ID!]!) {
         nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } }
       }`,
      { ids: block.map((a) => a.shopify_variant_id) },
    )
    for (const node of data.nodes) {
      if (!node?.inventoryItem) continue
      const angebot = block.find((a) => a.shopify_variant_id === node.id)
      if (!angebot) continue
      await sql`update shopify_zweitangebote set shopify_inventory_item_gid = ${node.inventoryItem.id}
                where id = ${angebot.angebot_id} and shopify_inventory_item_gid is null`
      angebot.inventory_item_gid = node.inventoryItem.id
    }
  }
}

// --- Probelauf ---------------------------------------------------------------------

interface ProbeFelder {
  name: string
  mto: boolean
  probe_qty: number | null
  probe_eingerichtet: boolean
}

/** Geändert gegenüber dem Probe-Stand (oder nie „gemeldet")? */
const probeGeaendert = (v: { frei: number; probe_qty: number | null }) =>
  v.probe_qty === null || Math.floor(Number(v.frei)) !== Math.floor(Number(v.probe_qty))

/**
 * Bestandsabgleich im Probelauf: dieselbe Soll-Menge, derselbe Diff — aber
 * statt inventorySetQuantities ein Protokolleintrag „würde senden" mit
 * Artikelnamen (für die Debug-Box), und der Probe-Stand (probe_qty) statt
 * pushed_qty. So zeigt jede Runde nur Änderungen, und beim Scharfschalten
 * wird trotzdem alles einmal wirklich gemeldet. Zweitangebote (0106) stehen
 * als eigener Eintrag darunter — scharf ist es auch eine eigene Mutation.
 */
async function probeInventar(varianten: VarianteZeile[], angebote: AngebotZeile[]): Promise<PushErgebnis> {
  const { logTransaction } = await import('./transaktionen')
  const einrichten = varianten.filter((v) => v.mto && !v.probe_eingerichtet)
  const angeboteEinrichten = angebote.filter((a) => a.mto && !a.probe_eingerichtet)
  if (einrichten.length > 0 || angeboteEinrichten.length > 0) {
    await logTransaction({
      system: 'shopify',
      kind: 'probe:productVariantsBulkUpdate',
      request: {
        zweck: 'Made-to-Order einrichten: Menge verfolgen, nicht ohne Bestand verkaufen',
        varianten: [
          ...einrichten.map((v) => v.name),
          ...angeboteEinrichten.map((a) => `${a.name} (Zweitangebot „${a.produkt}")`),
        ],
      },
      ok: true,
      error: 'Probelauf: nicht gesendet',
    })
    for (const v of einrichten) {
      await sql`
        insert into shopify_inventory_state (variant_id, probe_eingerichtet_at) values (${v.variant_id}, now())
        on conflict (variant_id) do update set probe_eingerichtet_at = now()`
    }
    for (const a of angeboteEinrichten) {
      await sql`update shopify_zweitangebote set probe_eingerichtet_at = now() where id = ${a.angebot_id}`
    }
  }

  const melden = varianten.filter(probeGeaendert)
  if (melden.length > 0) {
    await logTransaction({
      system: 'shopify',
      kind: 'probe:inventorySetQuantities',
      request: {
        aenderungen: melden.map((v) => ({
          sku: v.sku,
          name: v.name,
          vorher: v.probe_qty === null ? null : Math.floor(Number(v.probe_qty)),
          neu: Math.floor(Number(v.frei)),
        })),
      },
      ok: true,
      error: 'Probelauf: nicht gesendet',
    })
    for (const v of melden) {
      await sql`
        insert into shopify_inventory_state (variant_id, probe_qty, probe_at)
        values (${v.variant_id}, ${Math.floor(Number(v.frei))}, now())
        on conflict (variant_id) do update set probe_qty = excluded.probe_qty, probe_at = now()`
    }
  }

  const angeboteMeldenProbe = angebote.filter(probeGeaendert)
  if (angeboteMeldenProbe.length > 0) {
    await logTransaction({
      system: 'shopify',
      kind: 'probe:inventorySetQuantities',
      request: {
        zweitangebote: true,
        aenderungen: angeboteMeldenProbe.map((a) => ({
          sku: a.sku,
          name: a.name,
          angebot: a.produkt,
          vorher: a.probe_qty === null ? null : Math.floor(Number(a.probe_qty)),
          neu: Math.floor(Number(a.frei)),
        })),
      },
      ok: true,
      error: 'Probelauf: nicht gesendet',
    })
    for (const a of angeboteMeldenProbe) {
      await sql`update shopify_zweitangebote set probe_qty = ${Math.floor(Number(a.frei))}, probe_at = now()
                where id = ${a.angebot_id}`
    }
  }
  return {
    geprueft: varianten.length,
    uebertragen: melden.length,
    ohneZuordnung: 0,
    angebote: angebote.length,
    angeboteUebertragen: angeboteMeldenProbe.length,
    angeboteAbgelehnt: 0,
  }
}

// --- Made-to-Order in Shopify einrichten ----------------------------------------

/**
 * Für Tastaturen hatte Shopify keinen Bestandsabgleich (keine
 * Mengenverfolgung, Verkauf ohne Bestand). Damit die gemeldete baubare
 * Menge wirkt und 0 wirklich „ausverkauft" heißt, wird jede
 * Made-to-Order-Variante einmal umgestellt: Menge verfolgen an,
 * inventoryPolicy DENY. Danach gemerkt (mto_eingerichtet_at). Ihre
 * Zweitangebote (0106) genauso — sonst verkaufte das Bundle weiter, obwohl
 * die Tastatur bei 0 steht.
 */
async function madeToOrderEinrichten(
  varianten: { variant_id: string }[],
  angebote: { angebot_id: string; shopify_variant_id: string }[] = [],
): Promise<number> {
  if (varianten.length === 0 && angebote.length === 0) return 0
  const gids =
    varianten.length === 0
      ? []
      : await sql<{ id: string; gid: string }[]>`
          select id, shopify_variant_id as gid from product_variants
          where id in ${sql(varianten.map((v) => v.variant_id))}`
  const varianteZuGid = new Map(gids.map((r) => [r.gid, r.id]))
  const angebotZuGid = new Map(angebote.map((a) => [a.shopify_variant_id, a.angebot_id]))

  const jeProdukt = new Map<string, string[]>()
  const fertig: string[] = []
  for (const block of inBloecken([...varianteZuGid.keys(), ...angebotZuGid.keys()], 100)) {
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
      if (!varianteZuGid.has(node.id) && !angebotZuGid.has(node.id)) continue
      if (node.inventoryPolicy === 'DENY' && node.inventoryItem?.tracked) {
        fertig.push(node.id)
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
      // Ein Zweitangebot darf die Artikel nicht aufhalten: Grund merken,
      // weiter. Für Artikel bleibt es ein Fehler des Abgleichs.
      if (ids.every((id) => angebotZuGid.has(id))) {
        for (const id of ids) {
          await sql`update shopify_zweitangebote
                    set push_fehler = ${`Made-to-Order-Einrichtung abgelehnt: ${fehler.map((f) => f.message).join('; ')}`.slice(0, 500)}
                    where id = ${angebotZuGid.get(id)!}`
        }
        continue
      }
      throw new ShopifyError(`Made-to-Order-Einrichtung abgelehnt: ${fehler.map((f) => f.message).join('; ')}`, false)
    }
    fertig.push(...ids)
  }

  for (const gid of fertig) {
    const variantId = varianteZuGid.get(gid)
    if (variantId) {
      await sql`
        insert into shopify_inventory_state (variant_id, mto_eingerichtet_at) values (${variantId}, now())
        on conflict (variant_id) do update set mto_eingerichtet_at = now()`
    }
    const angebotId = angebotZuGid.get(gid)
    if (angebotId) {
      await sql`update shopify_zweitangebote set mto_eingerichtet_at = now() where id = ${angebotId}`
    }
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
  const null_ = { geprueft: 0, uebertragen: 0, ohneZuordnung: 0, angebote: 0, angeboteUebertragen: 0, angeboteAbgelehnt: 0 }
  if (gesperrt.length === 0) return { ...null_, runden: 0, gesperrt: true }

  const gesamt = { ...null_, runden: 0, gesperrt: false }
  try {
    let vorher: number
    do {
      vorher = await anstossZaehler()
      const r = await pushInventar()
      gesamt.geprueft = r.geprueft
      gesamt.uebertragen += r.uebertragen
      gesamt.ohneZuordnung = r.ohneZuordnung
      gesamt.angebote = r.angebote
      gesamt.angeboteUebertragen += r.angeboteUebertragen
      gesamt.angeboteAbgelehnt += r.angeboteAbgelehnt
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
 *
 * Nebenbei findet er Zweitangebote (0106): eine Shop-Variante ohne
 * Verknüpfung, deren SKU ein Artikel trägt — außer in Bundles, die sind nie
 * Lagerware. Gemerkt, bekommt sie ab dem nächsten Abgleich den Bestand.
 */
export async function shopStandHolen(): Promise<{
  varianten: number
  verkaufbar: number
  zugeordnet: number
  zweitangebote: number
}> {
  const ergebnis = { varianten: 0, verkaufbar: 0, zugeordnet: 0, zweitangebote: 0 }
  let after: string | null = null
  for (let seite = 0; seite < 40; seite++) {
    const data: {
      productVariants: {
        nodes: {
          id: string
          sku?: string | null
          barcode?: string | null
          inventoryQuantity: number | null
          inventoryPolicy: string
          availableForSale: boolean
          product: { id?: string; title?: string; status: string; hasVariantsThatRequiresComponents?: boolean | null }
          inventoryItem: { id: string; tracked: boolean } | null
        }[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } = await shopifyGraphQL(
      `query shopStand($after: String) {
         productVariants(first: 250, after: $after) {
           nodes {
             id sku barcode inventoryQuantity inventoryPolicy availableForSale
             product { id title status hasVariantsThatRequiresComponents }
             inventoryItem { id tracked }
           }
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
      if (!v) {
        if (n.product.hasVariantsThatRequiresComponents) continue
        const artikel = await zweitangebotMerken(sql, {
          gid: n.id,
          inventoryItemGid: n.inventoryItem?.id ?? null,
          productGid: n.product.id ?? null,
          produkt: n.product.title ?? null,
          sku: n.sku ?? null,
          barcode: n.barcode ?? null,
        })
        if (!artikel) continue
        ergebnis.zweitangebote++
        await sql`
          update shopify_zweitangebote
          set shop_qty = ${n.inventoryQuantity}, shop_seen_at = now(), shop_verkaufbar = ${n.availableForSale}
          where shopify_variant_id = ${n.id}`
        continue
      }
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
  if (!variante) return angebotWebhook(meldung)

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

/**
 * Dieselbe Regel für Zweitangebote (0106): mehr im Shop als das Soll →
 * sofort korrigieren; weniger → nur merken, der nächste Abgleich setzt es.
 */
async function angebotWebhook(meldung: { inventoryItemGid: string; verfuegbar: number }): Promise<string> {
  const [angebot] = await sql<{ id: string; bezeichnung: string; frei: number }[]>`
    select id, coalesce(sku, produkt, shopify_variant_id) as bezeichnung,
           shopify_soll_menge_zweitangebot(id) as frei
    from shopify_zweitangebote where shopify_inventory_item_gid = ${meldung.inventoryItemGid}`
  if (!angebot) return 'InventoryItem keiner Variante zugeordnet — übersprungen'
  await sql`update shopify_zweitangebote set shop_qty = ${meldung.verfuegbar}, shop_seen_at = now()
            where id = ${angebot.id}`
  const soll = Math.floor(angebot.frei)
  if (meldung.verfuegbar > soll) {
    await sql`select inventar_abgleich_anstossen()`
    return `Abweichung beim Zweitangebot ${angebot.bezeichnung}: Shop ${meldung.verfuegbar}, ERP ${soll} — Abgleich angestoßen`
  }
  if (meldung.verfuegbar < soll) {
    await sql`update shopify_zweitangebote set pushed_qty = ${meldung.verfuegbar} where id = ${angebot.id}`
    return `Zweitangebot ${angebot.bezeichnung} im Shop niedriger: Shop ${meldung.verfuegbar}, ERP ${soll} — wird beim nächsten Abgleich gesetzt`
  }
  return `Stand bestätigt (Zweitangebot ${angebot.bezeichnung}: ${meldung.verfuegbar})`
}
