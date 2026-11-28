import { randomUUID } from 'node:crypto'
import { sql } from '@/db/client'
import { ShopifyError, shopifyGraphQL } from './shopify'
import {
  type AngebotMitBestand,
  type AngebotStand,
  DELTA_MUTATION,
  erhoehungenImBudget,
  istVeraltet,
  INVENTAR_MUTATION,
  type VarianteMitBestand,
  bestandsInput,
  deltaInput,
  deuteInventarPayload,
  fehlerJePosition,
  inBloecken,
  meldungPlanen,
} from './inventar-logik'
import { type Abnehmer, kontingentVerteilen } from './kontingent-logik'
import { madeToOrderEinstellung } from './made-to-order'
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
  /**
   * Auf die nächste Runde verschoben (0136): Senkungen, auf denen ein
   * unbekannter Kauf liegt, und Erhöhungen, die deshalb noch nicht gedeckt sind.
   */
  verschoben?: number
}

/** Was die Kontingent-Rechnung je Angebot braucht (0136). */
interface KontingentFelder {
  /** Menge ohne Teilen — der Deckel des Angebots (shopify_soll_menge). */
  soll: number
  buch_ab: Date | null
  modus: string
  gewicht: number
  verkauft: number
  eigen: number
  bedarf: [string, number][]
}

type VarianteZeile = VarianteMitBestand & ProbeFelder & KontingentFelder & { mto: boolean; eingerichtet: boolean; shopify_variant_id: string }
type AngebotZeile = AngebotMitBestand & ProbeFelder & KontingentFelder & { shopify_variant_id: string; eingerichtet: boolean }

/**
 * Zweitangebote mit Soll-Menge (0106) — ohne Angebote, die inzwischen selbst
 * verknüpftes Angebot eines Artikels sind (die meldet der normale Weg).
 */
async function zweitangeboteLaden(): Promise<AngebotZeile[]> {
  // Die Soll-Menge wird EINMAL gerechnet (sie ist die teuerste Spalte) —
  // `frei` startet als Kopie und wird danach zum Ziel der Meldung.
  const zeilen = await sql<AngebotZeile[]>`
    select z.id as angebot_id, z.variant_id, coalesce(z.sku, v.sku) as sku,
           v.display_name as name, coalesce(z.produkt, 'Zweitangebot') as produkt,
           z.shopify_variant_id,
           z.shopify_inventory_item_gid as inventory_item_gid,
           shopify_soll_menge_zweitangebot(z.id) as soll,
           z.pushed_qty, z.buch_ab, z.push_fehler_qty,
           ist_made_to_order(z.variant_id) as mto,
           z.mto_eingerichtet_at is not null as eingerichtet,
           z.probe_qty,
           z.probe_eingerichtet_at is not null as probe_eingerichtet,
           case when z.shop_modus in ('aus', 'immer') then z.shop_modus else shop_modus_von(z.variant_id) end as modus,
           shop_gewicht(z.variant_id) * coalesce(z.shop_gewicht, 1) as gewicht,
           0 as verkauft,
           greatest(shop_frei(z.variant_id), 0) as eigen,
           coalesce((select json_agg(json_build_array(b.komponente, b.je)) from shop_bedarf(z.variant_id) b), '[]'::json) as bedarf
    from shopify_zweitangebote z
    join product_variants v on v.id = z.variant_id
    where v.active
      and not exists (select 1 from product_variants x where x.shopify_variant_id = z.shopify_variant_id)
    order by v.sku, z.produkt`
  for (const z of zeilen) z.frei = z.soll
  return zeilen
}

/** Alle Shopify-gekoppelten Varianten mit allem, was Kontingent und Meldung brauchen. */
async function variantenLaden(): Promise<VarianteZeile[]> {
  const zeilen = await sql<VarianteZeile[]>`
    select v.id as variant_id, v.sku, v.display_name as name, v.shopify_variant_id,
           v.shopify_inventory_item_gid as inventory_item_gid,
           shopify_soll_menge(v.id) as soll,
           s.pushed_qty, s.buch_ab,
           ist_made_to_order(v.id) as mto,
           s.mto_eingerichtet_at is not null as eingerichtet,
           s.probe_qty,
           s.probe_eingerichtet_at is not null as probe_eingerichtet,
           shop_modus_von(v.id) as modus,
           shop_gewicht(v.id) as gewicht,
           coalesce((select sum(l.qty) from sales_order_lines l
                     join sales_orders so on so.id = l.order_id
                     where l.variant_id = v.id and so.state <> 'cancel'
                       and so.order_date > now() - interval '6 hours'), 0) as verkauft,
           greatest(shop_frei(v.id), 0) as eigen,
           coalesce((select json_agg(json_build_array(b.komponente, b.je)) from shop_bedarf(v.id) b), '[]'::json) as bedarf
    from product_variants v
    left join shopify_inventory_state s on s.variant_id = v.id
    where v.shopify_variant_id is not null and v.active
    order by v.sku`
  for (const z of zeilen) z.frei = z.soll
  return zeilen
}

/**
 * Kontingent (0136): verteilt den freien Bestand jedes Teils auf die
 * Angebote, die es brauchen, und schreibt das Ergebnis als `frei` in die
 * Zeilen — ab hier ist `frei` das Ziel der Meldung, nicht mehr die Menge
 * ohne Teilen. Die Rechnung selbst liegt in kontingent-logik.ts.
 */
async function kontingentAnwenden(varianten: VarianteZeile[], angebote: AngebotZeile[]): Promise<KontingentLage> {
  const abnehmer: Abnehmer[] = []
  const eintrag = (id: string, z: KontingentFelder & { variant_id: string; mto: boolean }): Abnehmer => ({
    id,
    deckel: Math.max(Math.floor(Number(z.soll)), 0),
    // Was sich gerade verkauft, bekommt mehr: Grundgewicht × (1 + Stück der letzten sechs Stunden).
    gewicht: Math.max(Number(z.gewicht) || 1, 0.0001) * (1 + Math.max(Number(z.verkauft) || 0, 0)),
    // „Immer verfügbar" hängt an keinem Bestand — der Deckel gilt.
    bedarf: z.modus === 'immer' ? [] : z.bedarf.map(([komponente, je]) => ({ komponente, je: Number(je) })),
    eigen: z.mto && Number(z.eigen) > 0 ? { schluessel: z.variant_id, menge: Number(z.eigen) } : undefined,
  })
  for (const v of varianten) abnehmer.push(eintrag(`v:${v.variant_id}`, v))
  for (const a of angebote) abnehmer.push(eintrag(`z:${a.angebot_id}`, a))

  const teile = [...new Set(abnehmer.flatMap((a) => a.bedarf.map((b) => b.komponente)))]
  const pool = new Map<string, number>()
  if (teile.length > 0) {
    const zeilen = await sql<{ id: string; menge: number }[]>`
      select k as id, shop_pool(k) as menge from unnest(${teile}::uuid[]) k`
    for (const z of zeilen) pool.set(z.id, Number(z.menge))
    // Shop-Bestellungen im Entwurf: im Shop schon abgezogen, in KRNL noch nicht reserviert.
    const entwurf = await sql<{ komponente: string; menge: number }[]>`select komponente, menge from shop_entwurf_bedarf()`
    for (const e of entwurf) {
      if (pool.has(e.komponente)) pool.set(e.komponente, Math.max(pool.get(e.komponente)! - Number(e.menge), 0))
    }
  }

  const ausEigen = new Map<string, number>()
  const kontingent = kontingentVerteilen(abnehmer, pool, ausEigen)
  for (const v of varianten) v.frei = kontingent.get(`v:${v.variant_id}`) ?? 0
  for (const a of angebote) a.frei = kontingent.get(`z:${a.angebot_id}`) ?? 0

  await zielFesthalten(varianten, angebote)
  return {
    pool,
    bedarf: new Map(abnehmer.map((a) => [a.id, a.bedarf])),
    gewicht: new Map(abnehmer.map((a) => [a.id, a.gewicht])),
    ausEigen,
  }
}

/** Fürs Auge (Shop-Verfügbarkeit): das Ziel je Angebot festhalten. */
async function zielFesthalten(varianten: VarianteZeile[], angebote: AngebotZeile[]): Promise<void> {
  if (varianten.length > 0) {
    await sql`
      insert into shopify_inventory_state (variant_id, kontingent, kontingent_at)
      select x.id, x.k, now()
      from unnest(${varianten.map((v) => v.variant_id)}::uuid[], ${varianten.map((v) => v.frei)}::int[]) as x(id, k)
      on conflict (variant_id) do update set kontingent = excluded.kontingent, kontingent_at = now()
      where shopify_inventory_state.kontingent is distinct from excluded.kontingent`
  }
  if (angebote.length > 0) {
    await sql`
      update shopify_zweitangebote z set kontingent = x.k, kontingent_at = now()
      from unnest(${angebote.map((a) => a.angebot_id)}::uuid[], ${angebote.map((a) => a.frei)}::int[]) as x(id, k)
      where z.id = x.id and z.kontingent is distinct from x.k`
  }
}

/**
 * Feste Menge (Entscheidungslog 2026-11-28, „wie früher in Odoo"): im Modus
 * „fest" wird NICHT aufgeteilt. Jedes Angebot bekommt, was es allein bekäme
 * (shopify_soll_menge: der Deckel, solange das Material über Puffer und
 * Teile-Schwellen liegt, sonst 0). Fällt ein Teil unter seine Schwelle,
 * gehen damit alle Angebote auf 0, die es in der Stückliste haben. Der
 * Preis: die Summe der Angebote liegt über dem Bestand — was zwischen dem
 * Unterschreiten und der nächsten Meldung verkauft wird, ist überverkauft.
 * Dafür sind die Schwellen da.
 */
async function festeMengeAnwenden(varianten: VarianteZeile[], angebote: AngebotZeile[]): Promise<void> {
  for (const v of varianten) v.frei = Math.max(Math.floor(Number(v.soll)), 0)
  for (const a of angebote) a.frei = Math.max(Math.floor(Number(a.soll)), 0)
  await zielFesthalten(varianten, angebote)
}

/** Was die Meldung von der Kontingent-Rechnung wissen muss, um Erhöhungen zu decken. */
interface KontingentLage {
  pool: Map<string, number>
  bedarf: Map<string, { komponente: string; je: number }[]>
  gewicht: Map<string, number>
  ausEigen: Map<string, number>
}

/** Not-Aus (S6): steht er, ist das Ziel jedes Angebots 0. */
export async function notAusAktiv(): Promise<boolean> {
  const [row] = await sql<{ an: boolean | null }[]>`
    select (value -> 'not_aus' ->> 'aktiv')::boolean as an from settings where key = 'shopify'`
  return row?.an === true
}

/** Ein Angebot auf dem Weg zum Shop: Variante oder Zweitangebot. */
type Posten = { art: 'v' | 'z'; id: string; inventory_item_gid: string | null; frei: number; shop_gid?: string | null }

/** Was zeigt der Shop JETZT? Menge je Shop-Variante — für Angebote, deren Senkung er abgelehnt hat. */
async function shopMengenLesen(gids: string[]): Promise<Map<string, number>> {
  const mengen = new Map<string, number>()
  for (const block of inBloecken([...new Set(gids)], 100)) {
    const data = await shopifyGraphQL<{ nodes: ({ id: string; inventoryQuantity: number | null } | null)[] }>(
      `query shopMengen($ids: [ID!]!) {
         nodes(ids: $ids) { ... on ProductVariant { id inventoryQuantity } }
       }`,
      { ids: block },
    )
    for (const n of data.nodes) if (n && typeof n.inventoryQuantity === 'number') mengen.set(n.id, n.inventoryQuantity)
  }
  return mengen
}

/** Buch um eine Differenz fortschreiben — als Rechnung in der Datenbank, nie als fester Wert. */
async function buchFortschreiben(posten: (Posten & { delta: number })[], vorzeichen: 1 | -1): Promise<void> {
  const v = posten.filter((p) => p.art === 'v')
  const z = posten.filter((p) => p.art === 'z')
  if (v.length > 0) {
    await sql`
      update shopify_inventory_state s set pushed_qty = s.pushed_qty + x.d, pushed_at = now()
      from unnest(${v.map((p) => p.id)}::uuid[], ${v.map((p) => p.delta * vorzeichen)}::int[]) as x(id, d)
      where s.variant_id = x.id`
  }
  if (z.length > 0) {
    await sql`
      update shopify_zweitangebote s set pushed_qty = s.pushed_qty + x.d, pushed_at = now(),
             push_fehler = null, push_fehler_qty = null
      from unnest(${z.map((p) => p.id)}::uuid[], ${z.map((p) => p.delta * vorzeichen)}::int[]) as x(id, d)
      where s.id = x.id`
  }
}

/**
 * Buch nach einer absoluten Meldung: ab jetzt zählen Bestellungen dagegen —
 * mit fünf Sekunden Abstand (eigene Uhr gegen die des Shops; im Zweifel
 * zählt eine Bestellung nicht, dann zeigt der Shop eher zu wenig).
 */
async function buchSetzen(posten: Posten[]): Promise<void> {
  const v = posten.filter((p) => p.art === 'v')
  const z = posten.filter((p) => p.art === 'z')
  if (v.length > 0) {
    await sql`
      insert into shopify_inventory_state (variant_id, pushed_qty, pushed_at, buch_ab, shop_qty, shop_seen_at)
      select x.id, x.q, now(), now() + interval '5 seconds', x.q, now()
      from unnest(${v.map((p) => p.id)}::uuid[], ${v.map((p) => Math.floor(p.frei))}::int[]) as x(id, q)
      on conflict (variant_id) do update
        set pushed_qty = excluded.pushed_qty, pushed_at = now(), buch_ab = excluded.buch_ab,
            shop_qty = excluded.shop_qty, shop_seen_at = now()`
  }
  if (z.length > 0) {
    await sql`
      update shopify_zweitangebote s
      set pushed_qty = x.q, pushed_at = now(), buch_ab = now() + interval '5 seconds', shop_qty = x.q, shop_seen_at = now(),
          push_fehler = null, push_fehler_qty = null
      from unnest(${z.map((p) => p.id)}::uuid[], ${z.map((p) => Math.floor(p.frei))}::int[]) as x(id, q)
      where s.id = x.id`
  }
}

/**
 * Sendet einen Block an Shopify. Lehnt der Shop einzelne Positionen ab, gilt
 * die ganze Mutation als nicht ausgeführt: die genannten Positionen fallen
 * heraus (Zweitangebote merken den Grund), der Rest wird einmal wiederholt.
 * Rückgabe: was wirklich gesendet wurde, und die Ablehnungen.
 */
async function blockSenden<T extends Posten>(
  block: T[],
  mutation: string,
  eingabe: (teil: T[]) => Record<string, unknown>,
  feld: 'inventorySetQuantities' | 'inventoryAdjustQuantities',
): Promise<{ gesendet: T[]; abgelehnt: { posten: T; grund: string }[] }> {
  let offen = block
  const abgelehnt: { posten: T; grund: string }[] = []
  for (let versuch = 0; versuch < 3 && offen.length > 0; versuch++) {
    const data = await shopifyGraphQL<Record<string, { userErrors: { field: string[] | null; message: string; code?: string | null }[] }>>(
      mutation,
      { input: eingabe(offen), idempotencyKey: randomUUID() },
    )
    const fehler = data[feld].userErrors
    if (fehler.length === 0) return { gesendet: offen, abgelehnt }
    const jePosition = fehlerJePosition(offen.length, fehler.map((f) => ({ field: f.field, message: f.code ? `${f.message} [${f.code}]` : f.message })))
    // Nennt der Shop keine Position (alle gelten als abgelehnt): halbieren —
    // sonst hielte eine einzige abgelehnte Position den ganzen Block auf.
    if (jePosition.size === offen.length && offen.length > 1 && fehler.length < offen.length) {
      const mitte = Math.ceil(offen.length / 2)
      const links = await blockSenden(offen.slice(0, mitte), mutation, eingabe, feld)
      const rechts = await blockSenden(offen.slice(mitte), mutation, eingabe, feld)
      return { gesendet: [...links.gesendet, ...rechts.gesendet], abgelehnt: [...abgelehnt, ...links.abgelehnt, ...rechts.abgelehnt] }
    }
    for (const [i, grund] of jePosition) abgelehnt.push({ posten: offen[i], grund })
    offen = offen.filter((_, i) => !jePosition.has(i))
  }
  return { gesendet: [], abgelehnt: [...abgelehnt, ...offen.map((posten) => ({ posten, grund: 'nach Wiederholung weiter abgelehnt' }))] }
}

/** Ablehnungen vermerken: am Zweitangebot mit Grund; Artikel sammeln sich für die Fehlermeldung. */
async function ablehnungenMerken(abgelehnt: { posten: Posten; grund: string }[]): Promise<string[]> {
  const artikel: string[] = []
  for (const { posten, grund } of abgelehnt) {
    if (posten.art === 'z') {
      await sql`update shopify_zweitangebote set push_fehler = ${grund.slice(0, 500)}, push_fehler_qty = ${Math.floor(posten.frei)}
                where id = ${posten.id}`
    } else {
      artikel.push(grund)
    }
  }
  return artikel
}

/**
 * Meldet die Kontingente an den Shop (0136, Entscheidungslog 2026-11-27):
 *
 * 1. Kontingent rechnen — die Summe über alle Angebote, die ein Teil
 *    brauchen, übersteigt nie dessen freien Bestand.
 * 2. Nur die DIFFERENZ zum Buch senden (inventoryAdjustQuantities), nie
 *    eine absolute Menge: ein Kauf, den KRNL noch nicht kennt, bleibt im
 *    Shop abgezogen. Absolut gesetzt wird nur, was noch nie gemeldet wurde
 *    — und alles beim Not-Aus.
 * 3. Reihenfolge: erst senken, dann erstmalig setzen, zuletzt heben — die
 *    Summe liegt auch mitten in der Meldung nie über dem Bestand.
 *    Gesenkt wird MIT Vergleichswert (der Shop senkt nur, wenn er den
 *    Buchwert zeigt): liegt ein unbekannter Kauf auf dem Angebot, wäre die
 *    Senkung nur scheinbar. Der Shop lehnt dann ab, das Angebot behält
 *    seinen Stand, und erhöht wird nur, was aus wirklich freiem Bestand
 *    gedeckt ist (erhoehungenImBudget).
 * 4. Buch und Shop bleiben auch bei einem Abbruch auf der sicheren Seite:
 *    gesenkt wird erst im Shop, dann im Buch; gehoben erst im Buch, dann im
 *    Shop. Reißt die Verbindung dazwischen, zeigt der Shop zu wenig, nie zu
 *    viel — der Abgleich heilt es.
 *
 * Ein leerer Durchlauf kostet keinen einzigen API-Aufruf.
 */
export async function pushInventar(): Promise<PushErgebnis> {
  const varianten = await variantenLaden()
  const angebote = await zweitangeboteLaden()

  const leer = { geprueft: 0, uebertragen: 0, ohneZuordnung: 0, angebote: 0, angeboteUebertragen: 0, angeboteAbgelehnt: 0 }
  if (varianten.length === 0 && angebote.length === 0) return leer

  const notAus = await notAusAktiv()
  const mto = await madeToOrderEinstellung()
  const fest = !notAus && mto.modus === 'fest'
  let lage: KontingentLage | null = null
  if (notAus) {
    for (const v of varianten) v.frei = 0
    for (const a of angebote) a.frei = 0
  } else if (fest) {
    // Feste Menge: keine Aufteilung, also auch kein Budget für Erhöhungen (lage bleibt leer).
    await festeMengeAnwenden(varianten, angebote)
  } else {
    lage = await kontingentAnwenden(varianten, angebote)
  }

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

  const posten: (Posten & AngebotStand & { fehlerMenge: number | null; shop_gid: string | null })[] = [
    ...varianten.map((v) => ({
      art: 'v' as const, id: v.variant_id, inventory_item_gid: v.inventory_item_gid, frei: v.frei,
      pushed_qty: v.pushed_qty, buch_ab: v.buch_ab, fehlerMenge: null, shop_gid: v.shopify_variant_id,
    })),
    ...angebote.map((a) => ({
      art: 'z' as const, id: a.angebot_id, inventory_item_gid: a.inventory_item_gid, frei: a.frei,
      pushed_qty: a.pushed_qty, buch_ab: a.buch_ab, fehlerMenge: a.push_fehler_qty, shop_gid: a.shopify_variant_id,
    })),
  ]
  // Not-Aus setzt ALLES absolut auf 0 — unabhängig vom Buch, solange es nicht schon bei 0 steht.
  const plan = notAus
    ? {
        erst: posten.filter((p) => p.inventory_item_gid && (p.pushed_qty === null || p.buch_ab === null || Number(p.pushed_qty) !== 0)),
        senken: [], heben: [],
        ohneZuordnung: posten.filter((p) => !p.inventory_item_gid),
      }
    : meldungPlanen(posten)
  // Ein Zweitangebot, dessen Menge Shopify schon einmal abgelehnt hat, versucht es erst mit neuer Menge wieder.
  const versuchen = <T extends { art: 'v' | 'z'; frei: number; fehlerMenge: number | null }>(liste: T[]) =>
    liste.filter((p) => p.art === 'v' || p.fehlerMenge === null || Math.floor(Number(p.fehlerMenge)) !== Math.floor(p.frei))
  // Feste Menge (Schnellstopp, Entscheidungslog 2026-11-28):
  // - „Auf 0" geht ABSOLUT und zuerst: ein Aufruf, den der Shop nie wegen
  //   eines Kaufs dazwischen ablehnt — 0 kann nichts überverkaufen. (Im
  //   Modus „aufgeteilt" bleibt es beim Senken mit Vergleichswert: dort
  //   würde eine scheinbare Senkung Bestand freigeben, der anderswo erhöht
  //   wird.)
  // - Nach einem Verkauf wird NICHT wieder auf die feste Menge aufgefüllt:
  //   das kostete einen Shop-Aufruf je Bestellung und im Ansturm das
  //   Abruf-Kontingent, das der Stopp braucht. Aufgefüllt wird erst, wenn
  //   das Angebot unter die Hälfte gefallen ist (oder wieder aufmacht).
  const stopp = fest ? versuchen(plan.senken.filter((p) => Math.floor(p.frei) <= 0)) : []
  const senken = versuchen(fest ? plan.senken.filter((p) => Math.floor(p.frei) > 0) : plan.senken)
  const erst = versuchen(plan.erst)
  const heben = versuchen(
    fest
      ? plan.heben.filter((p) => Math.floor(p.frei) < mto.deckel || Math.round(Number(p.pushed_qty)) <= mto.deckel / 2)
      : plan.heben,
  )

  const ergebnis = {
    geprueft: varianten.length,
    uebertragen: 0,
    ohneZuordnung: plan.ohneZuordnung.length,
    angebote: angebote.length,
    angeboteUebertragen: 0,
    angeboteAbgelehnt: 0,
    verschoben: 0,
  }
  if (stopp.length === 0 && senken.length === 0 && erst.length === 0 && heben.length === 0) return ergebnis

  const location = await locationGid()
  const fehlerArtikel: string[] = []
  const zaehlen = (gesendet: Posten[], abgelehnt: { posten: Posten }[]) => {
    ergebnis.uebertragen += gesendet.filter((p) => p.art === 'v').length
    ergebnis.angeboteUebertragen += gesendet.filter((p) => p.art === 'z').length
    ergebnis.angeboteAbgelehnt += abgelehnt.filter((a) => a.posten.art === 'z').length
  }

  // Buchstand je Angebot, fortgeschrieben mit dem, was der Shop wirklich annimmt.
  const buchNach = new Map<string, number>()
  for (const p of posten) buchNach.set(`${p.art}:${p.id}`, p.pushed_qty === null ? 0 : Math.round(Number(p.pushed_qty)))

  // 0. Stopp (nur feste Menge): absolut auf 0, danach das Buch.
  for (const block of inBloecken(stopp, 200)) {
    const r = await blockSenden(block, INVENTAR_MUTATION, (teil) => bestandsInput(teil, location), 'inventorySetQuantities')
    await buchSetzen(r.gesendet)
    for (const p of r.gesendet) buchNach.set(`${p.art}:${p.id}`, 0)
    fehlerArtikel.push(...(await ablehnungenMerken(r.abgelehnt)))
    zaehlen(r.gesendet, r.abgelehnt)
  }

  // 1. Senken: erst der Shop, dann das Buch — GESÄTTIGT und mit
  //    Vergleichswert. Erst nachsehen, was der Shop zeigt, dann höchstens
  //    um das senken, was wirklich noch dasteht: was schon verkauft ist
  //    (unbekannter Kauf), lässt sich nicht mehr senken — das Angebot hält
  //    dann mehr als sein Kontingent, und genau so viel weniger wird unten
  //    erhöht. Der Vergleichswert sichert die Zeit zwischen Lesen und
  //    Schreiben: kauft jemand dazwischen, lehnt der Shop ab (kein Fehler,
  //    die nächste Runde versucht es neu).
  for (const block of inBloecken(senken, 200)) {
    const mengen = await shopMengenLesen(block.map((p) => p.shop_gid ?? '').filter(Boolean))
    const gesaettigt: ((typeof block)[number] & { erwartet: number })[] = []
    for (const p of block) {
      const imShop = p.shop_gid ? mengen.get(p.shop_gid) : undefined
      if (imShop === undefined) {
        ergebnis.verschoben++
        continue
      }
      let buch = Math.round(Number(p.pushed_qty))
      if (imShop > buch) {
        // Der Shop zeigt MEHR als das Buch (von Hand geändert): das Buch übernimmt.
        await buchSetzen([{ ...p, frei: imShop }])
        buch = imShop
        buchNach.set(`${p.art}:${p.id}`, buch)
      }
      const wunsch = buch - Math.floor(p.frei)
      const d = Math.min(wunsch, Math.max(imShop, 0))
      if (d < wunsch) ergebnis.verschoben++
      if (d <= 0) continue
      gesaettigt.push({ ...p, delta: -d, erwartet: imShop, frei: buch - d })
    }
    if (gesaettigt.length === 0) continue
    const r = await blockSenden(
      gesaettigt, DELTA_MUTATION, (teil) => deltaInput(teil, location), 'inventoryAdjustQuantities',
    )
    await buchFortschreiben(r.gesendet, 1)
    for (const p of r.gesendet) buchNach.set(`${p.art}:${p.id}`, Math.floor(p.frei))
    const echt = r.abgelehnt.filter((x) => !istVeraltet(x.grund))
    ergebnis.verschoben += r.abgelehnt.length - echt.length
    fehlerArtikel.push(...(await ablehnungenMerken(echt)))
    zaehlen(r.gesendet, echt)
  }

  // 2. Erstmalig (oder Not-Aus): absolut setzen, danach läuft das Buch.
  for (const block of inBloecken(erst, 200)) {
    const r = await blockSenden(block, INVENTAR_MUTATION, (teil) => bestandsInput(teil, location), 'inventorySetQuantities')
    await buchSetzen(r.gesendet)
    for (const p of r.gesendet) buchNach.set(`${p.art}:${p.id}`, Math.floor(p.frei))
    fehlerArtikel.push(...(await ablehnungenMerken(r.abgelehnt)))
    zaehlen(r.gesendet, r.abgelehnt)
  }

  // 3. Heben: erst das Buch, dann der Shop — scheitert die Meldung sicher
  //    (Ablehnung, Drosselung), geht das Buch zurück; bei unklarem Ausgang
  //    bleibt es stehen (der Shop zeigt dann eher zu wenig).
  //    Gedeckt ist eine Erhöhung nur aus Bestand, den die Angebote laut
  //    Buch nicht mehr halten: hat der Shop oben eine Senkung abgelehnt,
  //    bindet jenes Angebot seine Teile weiter.
  let hebenGedeckt = heben
  if (lage && heben.length > 0) {
    const gehalten = new Map<string, number>()
    for (const [id, b] of buchNach) gehalten.set(id, Math.max(b - (lage.ausEigen.get(id) ?? 0), 0))
    const reihenfolge = [...heben].sort(
      (x, y) => (lage!.gewicht.get(`${y.art}:${y.id}`) ?? 1) - (lage!.gewicht.get(`${x.art}:${x.id}`) ?? 1),
    )
    const erlaubt = erhoehungenImBudget(
      reihenfolge.map((p) => ({ id: `${p.art}:${p.id}`, delta: p.delta })), gehalten, lage.bedarf, lage.pool,
    )
    hebenGedeckt = heben
      .map((p) => ({ ...p, delta: erlaubt.get(`${p.art}:${p.id}`) ?? 0 }))
      .filter((p) => p.delta > 0)
      .map((p) => ({ ...p, frei: Math.round(Number(p.pushed_qty)) + p.delta }))
    ergebnis.verschoben += heben.length - hebenGedeckt.length
  }
  for (const block of inBloecken(hebenGedeckt, 200)) {
    await buchFortschreiben(block, 1)
    try {
      const r = await blockSenden(block, DELTA_MUTATION, (teil) => deltaInput(teil, location), 'inventoryAdjustQuantities')
      await buchFortschreiben(r.abgelehnt.map((a) => a.posten as (typeof block)[number]), -1)
      fehlerArtikel.push(...(await ablehnungenMerken(r.abgelehnt)))
      zaehlen(r.gesendet, r.abgelehnt)
    } catch (err) {
      const sicherNichtGebucht =
        !(err instanceof ShopifyError) || !err.retryable || /thrott|429/i.test(err.message)
      if (sicherNichtGebucht) await buchFortschreiben(block, -1)
      throw err
    }
  }

  if (fehlerArtikel.length > 0) {
    throw new ShopifyError(`Bestandsmeldung abgelehnt: ${[...new Set(fehlerArtikel)].join('; ')}`, false)
  }
  return ergebnis
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

// --- Schnellstopp -------------------------------------------------------------------

/**
 * Schnellstopp (Entscheidungslog 2026-11-28, Modus „feste Menge"): direkt
 * nachdem eine Bestellung reserviert ist, gezielt sperren, was nicht mehr
 * geht — ohne den vollen Abgleich abzuwarten.
 *
 * Der volle Abgleich rechnet jedes Shop-Angebot neu; in der Produktion
 * dauerte das 5 bis 15 Sekunden, und so lange verkaufte der Shop die
 * Angebote mit dem knappen Teil weiter. Hier wird nur gefragt, ob DIESE
 * Artikel ein Teil unter die Schwelle gebracht haben
 * (shop_stopp_kandidaten, 0147) — im Regelfall ein paar Millisekunden und
 * kein Shop-Aufruf. Ist ein Teil knapp, gehen alle Angebote mit diesem
 * Teil in EINEM Aufruf absolut auf 0: 0 kann nichts überverkaufen, darum
 * braucht es weder den Shop-Stand noch einen Vergleichswert, und die
 * Sperre des vollen Abgleichs muss nicht abgewartet werden.
 *
 * Wieder aufgemacht (Nachschub, Storno) wird nur vom vollen Abgleich. Im
 * Modus „aufgeteilt" tut der Schnellstopp nichts — dort zählt der Shop
 * jedes Kontingent selbst herunter.
 *
 * Rückgabe: Zahl der gesperrten Angebote.
 */
export async function schnellStopp(variantIds: (string | null | undefined)[]): Promise<number> {
  const ids = [...new Set(variantIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return 0
  const [lage] = await sql<{ modus: string | null; mto: string | null; not_aus: boolean | null }[]>`
    select value ->> 'modus' as modus, value -> 'mto' ->> 'modus' as mto,
           (value -> 'not_aus' ->> 'aktiv')::boolean as not_aus
    from settings where key = 'shopify'`
  if (lage?.modus !== 'schreiben' || lage.mto !== 'fest' || lage.not_aus === true) return 0

  const kandidaten = await sql<{ art: 'v' | 'z'; id: string; inventory_item_gid: string | null }[]>`
    select art, id, inventory_item_gid from shop_stopp_kandidaten(${ids}::uuid[])`
  const posten: Posten[] = kandidaten
    .filter((k) => k.inventory_item_gid)
    .map((k) => ({ art: k.art, id: k.id, inventory_item_gid: k.inventory_item_gid, frei: 0 }))
  if (posten.length === 0) return 0

  const location = await locationGid()
  const gestoppt: Posten[] = []
  for (const block of inBloecken(posten, 200)) {
    const r = await blockSenden(block, INVENTAR_MUTATION, (teil) => bestandsInput(teil, location), 'inventorySetQuantities')
    await buchSetzen(r.gesendet)
    await ablehnungenMerken(r.abgelehnt)
    gestoppt.push(...r.gesendet)
  }
  // Fürs Auge (Shop-Verfügbarkeit): das Ziel dieser Angebote ist jetzt 0.
  const v = gestoppt.filter((p) => p.art === 'v').map((p) => p.id)
  const z = gestoppt.filter((p) => p.art === 'z').map((p) => p.id)
  if (v.length > 0) {
    await sql`update shopify_inventory_state set kontingent = 0, kontingent_at = now() where variant_id = any(${v}::uuid[])`
  }
  if (z.length > 0) {
    await sql`update shopify_zweitangebote set kontingent = 0, kontingent_at = now() where id = any(${z}::uuid[])`
  }
  return gestoppt.length
}

/**
 * Schnellstopp, der nie stört: für Aufrufer mitten in einem anderen Ablauf
 * (Bestellimport, Shop-Regel geändert). Scheitert er — Shop gedrosselt,
 * Verbindung weg —, holt der volle Abgleich es nach.
 */
export async function schnellStoppLeise(variantIds: (string | null | undefined)[]): Promise<number> {
  try {
    return await schnellStopp(variantIds)
  } catch {
    return 0
  }
}

/** Schnellstopp für die Artikel einer eben importierten Bestellung — leise, wie schnellStoppLeise. */
export async function schnellStoppNachBestellung(salesOrderId: string): Promise<number> {
  try {
    const artikel = await sql<{ variant_id: string }[]>`
      select distinct variant_id from sales_order_lines where order_id = ${salesOrderId} and variant_id is not null`
    return await schnellStopp(artikel.map((a) => a.variant_id))
  } catch {
    return 0
  }
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

// --- Buch heilen (S7) ------------------------------------------------------------

export interface BuchAbgleich {
  /** Shop zeigte mehr als das Buch — sofort übernommen (danach senkt der Abgleich). */
  hoch: number
  /** Shop zeigte weniger als das Buch — nur in ruhiger Zeit übernommen. */
  runter: number
  /** Keine offenen Bestell-Ereignisse — dann heilt, was seit drei Minuten nicht bestellt wurde. */
  ruhe: boolean
  /** Auftragsgefertigte Angebote, die im Shop wieder „weiterverkaufen" oder ohne Mengenverfolgung stehen. */
  einrichtung: number
}

/**
 * Gleicht das Buch mit dem frisch gelesenen Shop-Stand ab (S7, nach
 * shopStandHolen im Viertelstunden-Abgleich):
 *
 * - Shop zeigt MEHR als das Buch: nie durch Käufe erklärbar — sofort
 *   übernehmen, der nächste Abgleich senkt. Meldung per Telegram.
 * - Shop zeigt WENIGER: meist Käufe, die noch unterwegs sind. Übernommen
 *   wird je Angebot nur in ruhiger Zeit (keine offenen Bestell-Ereignisse,
 *   für diesen Artikel seit drei Minuten keine neue Shop-Bestellung) — dann
 *   ist es eine echte Abweichung, und der Shop bekommt den Rest zurück.
 * - „Nicht weiterverkaufen" und Mengenverfolgung der auftragsgefertigten
 *   Angebote: steht im Shop etwas anderes, richtet der nächste Abgleich sie
 *   neu ein.
 */
export async function buchAbgleichen(): Promise<BuchAbgleich> {
  // Frisch = eben gelesen, nach der letzten eigenen Buchung UND nach der
  // jüngsten gezählten Bestellung (0139) — sonst vergliche man einen alten
  // Shop-Stand mit einem Buch, das schon weiter ist.
  const frisch = sql`shop_seen_at > now() - interval '3 minutes' and (pushed_at is null or shop_seen_at > pushed_at)
                     and (buch_bestellt_bis is null or shop_seen_at > buch_bestellt_bis)`
  const hochV = await sql`
    update shopify_inventory_state
    set pushed_qty = shop_qty, buch_ab = shop_seen_at + interval '5 seconds', pushed_at = now()
    where pushed_qty is not null and buch_ab is not null and shop_qty is not null
      and shop_qty > round(pushed_qty) and ${frisch}
    returning variant_id`
  const hochZ = await sql`
    update shopify_zweitangebote
    set pushed_qty = shop_qty, buch_ab = shop_seen_at + interval '5 seconds', pushed_at = now()
    where pushed_qty is not null and buch_ab is not null and shop_qty is not null
      and shop_qty > round(pushed_qty) and ${frisch}
    returning id`

  // Ruhe je Angebot: keine offenen Bestell-Ereignisse, und für DIESEN
  // Artikel seit drei Minuten keine neue Shop-Bestellung. Ein Renner heilt
  // erst, wenn er zur Ruhe kommt; alles andere schon mitten im Ansturm.
  const [{ ruhe }] = await sql<{ ruhe: boolean }[]>`
    select not exists (select 1 from shopify_webhook_events
                       where status = 'pending' and (topic like 'orders/%' or topic like 'fulfillment_orders/%')) as ruhe`
  let runter = 0
  if (ruhe) {
    const juengst = sql`
      select 1 from sales_order_lines l join sales_orders so on so.id = l.order_id
      where so.source = 'shopify' and so.created_at > now() - interval '3 minutes'`
    const v = await sql`
      update shopify_inventory_state s
      set pushed_qty = shop_qty, buch_ab = shop_seen_at + interval '5 seconds', pushed_at = now()
      where pushed_qty is not null and buch_ab is not null and shop_qty is not null
        and shop_qty < round(pushed_qty) and ${frisch}
        and not exists (${juengst} and l.variant_id = s.variant_id)
      returning variant_id`
    const z = await sql`
      update shopify_zweitangebote s
      set pushed_qty = shop_qty, buch_ab = shop_seen_at + interval '5 seconds', pushed_at = now()
      where pushed_qty is not null and buch_ab is not null and shop_qty is not null
        and shop_qty < round(pushed_qty) and ${frisch}
        and not exists (${juengst} and l.variant_id = s.variant_id)
      returning id`
    runter = v.length + z.length
  }

  // „Nicht weiterverkaufen" erneut prüfen: weicht der Shop ab, neu einrichten.
  const neu = await sql`
    update shopify_inventory_state s
    set mto_eingerichtet_at = null
    where s.mto_eingerichtet_at is not null and ist_made_to_order(s.variant_id)
      and s.shop_seen_at > now() - interval '3 minutes'
      and (s.shop_policy is distinct from 'DENY' or s.shop_tracked is distinct from true)
      and s.shop_policy is not null
    returning variant_id`

  const hoch = hochV.length + hochZ.length
  if (hoch > 0 || runter > 0 || neu.length > 0) await sql`select inventar_abgleich_anstossen()`
  if (hoch > 0) {
    const { einreihen } = await import('./benachrichtigungen')
    await einreihen(sql, 'ueberverkauf', `abweichung:${new Date().toISOString().slice(0, 13)}`,
      `⚠️ <b>Abweichung im Shop</b>: ${hoch} ${hoch === 1 ? 'Angebot zeigte' : 'Angebote zeigten'} mehr als KRNL gebucht hat ` +
      '(von Hand im Shop geändert?). KRNL hat den Stand übernommen und senkt auf das Kontingent.')
  }
  return { hoch, runter, ruhe, einrichtung: neu.length }
}

// --- Webhook -------------------------------------------------------------------

/**
 * Verarbeitet inventory_levels/update: der Shop berichtet seinen Stand.
 *
 * Mit dem Buch (0136) gilt:
 * - Shop zeigt WENIGER als das Buch: der Normalfall — ein Kauf, den KRNL
 *   noch nicht eingelesen hat. Nichts tun; die Bestellung zieht es vom
 *   Buch ab, sobald sie da ist.
 * - Shop zeigt MEHR als das Buch: das erklärt kein Kauf — jemand hat im
 *   Shop von Hand gebucht oder ein Storno hat zurückgelagert. Das Buch
 *   übernimmt den Shop-Stand (ab dem Zeitpunkt der Meldung), der nächste
 *   Abgleich senkt auf das Kontingent.
 * Meldungen, die älter sind als die letzte eigene Buchung, zählen nicht —
 * Webhooks überholen einander.
 */
export async function verarbeiteInventarWebhook(
  payload: Record<string, unknown>,
): Promise<string> {
  const meldung = deuteInventarPayload(payload)
  if (!meldung) return 'Kein verwertbarer Bestands-Payload — übersprungen'

  const [variante] = await sql<{ id: string; sku: string | null }[]>`
    select id, sku from product_variants where shopify_inventory_item_gid = ${meldung.inventoryItemGid}`
  if (!variante) return angebotWebhook(meldung)

  const [stand] = await sql<{ buch: number | null; pushed_at: Date | null; bestellt_bis: Date | null }[]>`
    insert into shopify_inventory_state (variant_id, shop_qty, shop_seen_at)
    values (${variante.id}, ${meldung.verfuegbar}, now())
    on conflict (variant_id) do update
      set shop_qty = excluded.shop_qty, shop_seen_at = now()
    returning pushed_qty as buch, pushed_at, buch_bestellt_bis as bestellt_bis`
  const name = variante.sku ?? variante.id
  const urteil = shopStandBeurteilen(meldung, stand?.buch ?? null, stand?.pushed_at ?? null, stand?.bestellt_bis ?? null)
  if (urteil === 'mehr') {
    await sql`
      update shopify_inventory_state
      set pushed_qty = ${meldung.verfuegbar}, buch_ab = coalesce(${meldung.geaendertAm}, now() + interval '5 seconds'), pushed_at = now()
      where variant_id = ${variante.id}`
    await sql`select inventar_abgleich_anstossen()`
    return `Abweichung bei ${name}: Shop ${meldung.verfuegbar}, Buch ${Math.round(Number(stand!.buch))} — Buch übernimmt den Shop-Stand, Abgleich angestoßen`
  }
  if (urteil === 'weniger') {
    return `Shop niedriger bei ${name}: Shop ${meldung.verfuegbar}, Buch ${Math.round(Number(stand!.buch))} — Bestellung unterwegs, nichts zu tun`
  }
  if (urteil === 'veraltet') return `Veraltete Meldung zu ${name} (${meldung.verfuegbar}) — übersprungen`
  return `Stand bestätigt (${name}: ${meldung.verfuegbar})`
}

/**
 * Wie steht die Shop-Meldung zum Buch? Überholt ist sie, wenn sie älter ist
 * als die letzte eigene Buchung — oder nicht jünger als die jüngste
 * gezählte Bestellung (0139): dann hat das Buch diesen Kauf schon
 * abgezogen, und „mehr" wäre ein Trugschluss.
 */
function shopStandBeurteilen(
  meldung: { verfuegbar: number; geaendertAm: Date | null },
  buch: number | null,
  gebuchtAm: Date | null,
  bestelltBis: Date | null = null,
): 'ohne-buch' | 'veraltet' | 'mehr' | 'weniger' | 'gleich' {
  if (buch === null) return 'ohne-buch'
  if (meldung.geaendertAm && gebuchtAm && meldung.geaendertAm.getTime() < gebuchtAm.getTime()) return 'veraltet'
  // Sekundengenau: eine Meldung aus derselben Sekunde wie die Bestellung gilt als überholt.
  if (meldung.geaendertAm && bestelltBis && Math.floor(meldung.geaendertAm.getTime() / 1000) <= Math.floor(bestelltBis.getTime() / 1000)) {
    return 'veraltet'
  }
  const b = Math.round(Number(buch))
  return meldung.verfuegbar > b ? 'mehr' : meldung.verfuegbar < b ? 'weniger' : 'gleich'
}

/** Dieselbe Regel für Zweitangebote (0106). */
async function angebotWebhook(meldung: { inventoryItemGid: string; verfuegbar: number; geaendertAm: Date | null }): Promise<string> {
  const [angebot] = await sql<{ id: string; bezeichnung: string; buch: number | null; pushed_at: Date | null; bestellt_bis: Date | null }[]>`
    update shopify_zweitangebote set shop_qty = ${meldung.verfuegbar}, shop_seen_at = now()
    where shopify_inventory_item_gid = ${meldung.inventoryItemGid}
    returning id, coalesce(sku, produkt, shopify_variant_id) as bezeichnung, pushed_qty as buch, pushed_at,
              buch_bestellt_bis as bestellt_bis`
  if (!angebot) return 'InventoryItem keiner Variante zugeordnet — übersprungen'
  const urteil = shopStandBeurteilen(meldung, angebot.buch, angebot.pushed_at, angebot.bestellt_bis)
  if (urteil === 'mehr') {
    await sql`
      update shopify_zweitangebote
      set pushed_qty = ${meldung.verfuegbar}, buch_ab = coalesce(${meldung.geaendertAm}, now() + interval '5 seconds'), pushed_at = now()
      where id = ${angebot.id}`
    await sql`select inventar_abgleich_anstossen()`
    return `Abweichung beim Zweitangebot ${angebot.bezeichnung}: Shop ${meldung.verfuegbar}, Buch ${Math.round(Number(angebot.buch))} — Buch übernimmt den Shop-Stand, Abgleich angestoßen`
  }
  if (urteil === 'weniger') {
    return `Zweitangebot ${angebot.bezeichnung} im Shop niedriger: Shop ${meldung.verfuegbar}, Buch ${Math.round(Number(angebot.buch))} — Bestellung unterwegs, nichts zu tun`
  }
  if (urteil === 'veraltet') return `Veraltete Meldung zum Zweitangebot ${angebot.bezeichnung} — übersprungen`
  return `Stand bestätigt (Zweitangebot ${angebot.bezeichnung}: ${meldung.verfuegbar})`
}
