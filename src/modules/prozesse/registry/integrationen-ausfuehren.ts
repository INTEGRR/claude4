import { sql, tx } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Integrations-Aktionen. */

export async function klaerfallAufloesen(
  p: { variant_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const lineId = ctx.recordId!
  const [line] = await sql<
    { sku: string | null; variant_gid: string | null; shopify_order_id: string | null }[]
  >`
    select sku, variant_gid, shopify_order_id from shopify_unmatched_lines where id = ${lineId}`
  if (!line) throw new Error('Klärfall nicht gefunden.')

  // Zuordnung dauerhaft an der Variante speichern, damit der nächste Import passt.
  if (line.variant_gid) {
    await sql`update product_variants set shopify_variant_id = ${line.variant_gid}
              where id = ${p.variant_id} and shopify_variant_id is null`
  }
  if (line.sku) {
    await sql`update product_variants set sku = ${line.sku}
              where id = ${p.variant_id} and sku is null`
  }

  await sql`update shopify_unmatched_lines
            set resolved_at = now(), resolved_variant = ${p.variant_id}
            where id = ${lineId}`
  await sql`select log_event('shopify_unmatched', ${lineId}::uuid, 'state',
    'Klärfall aufgelöst', ${ctx.actor})`

  // Sofort heilen: Bestellung frisch holen und den Import erneut anwerfen —
  // der zieht die geklärte Position nach (echter Preis) und bestätigt bei
  // Bezahlung. Schlägt der Abruf fehl, holt der nächste Abgleich das nach.
  if (line.shopify_order_id) {
    try {
      const { fetchOrder } = await import('@/modules/integrationen/shopify')
      const { importShopifyOrder } = await import('@/modules/integrationen/import')
      const order = await fetchOrder(line.shopify_order_id)
      if (order) {
        const ergebnis = await importShopifyOrder(order)
        return {
          text: `Klärfall aufgelöst — ${ergebnis.message}.`,
          recordId: ergebnis.salesOrderId ?? undefined,
        }
      }
    } catch {
      // bewusst still: die Auflösung steht, der Abgleich heilt später.
    }
  }
  return { text: 'Klärfall aufgelöst — der nächste Abgleich zieht die Position nach.' }
}

export async function webhooksRegistrieren(
  p: { url: string },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Der Shopify-Client zieht Next-Module — dynamisch, damit der Katalog
  // unter blankem Node ladbar bleibt.
  if (process.env.SHOPIFY_FAKE === '1') {
    throw new Error('Im Fake-Betrieb (SHOPIFY_FAKE=1) gibt es keinen Shop, bei dem Webhooks registriert werden könnten')
  }
  const { registerWebhooks, shopifyConfigured } = await import('@/modules/integrationen/shopify')
  if (!shopifyConfigured()) throw new Error('Shopify ist nicht konfiguriert — siehe Einstellungen → Schnittstellen')
  const r = await registerWebhooks(p.url)
  return {
    text: `Webhooks eingerichtet: ${r.angelegt} neu, ${r.aktualisiert} umgezogen, ${r.unveraendert} passten schon.`,
  }
}

// --- Shopify-Historie und Netto-Preise (0089) --------------------------------

export async function historiePruefenAktion(p: {
  skus: string[]
  namen: string[]
}): Promise<AktionsErgebnis> {
  const { historiePruefen } = await import('../../integrationen/historie-import.ts')
  const r = await historiePruefen(p.skus, p.namen)
  return {
    text:
      `${r.unbekannteSkus.length} von ${p.skus.length} SKUs sind KRNL unbekannt` +
      ` (werden archivierte Historie-Artikel), ${r.vorhanden} Bestellungen sind schon da.`,
    daten: { ...r },
  }
}

export async function historieImportierenAktion(
  p: { bestellungen: import('../../integrationen/shopify-csv.ts').HistorieBestellung[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { historieImportieren } = await import('../../integrationen/historie-import.ts')
  const r = await historieImportieren(p.bestellungen, ctx.actor)
  return {
    text:
      `${r.angelegt} übernommen, ${r.vorhanden} schon vorhanden` +
      (r.offenJung ? `, ${r.offenJung} offen (Live-Import)` : '') +
      (r.neueArtikel ? `, ${r.neueArtikel} Historie-Artikel angelegt` : '') +
      (r.fehler.length ? ` — ${r.fehler.length} Fehler: ${r.fehler.slice(0, 2).join(' | ')}` : ''),
    daten: { ...r },
  }
}

/** Je Lauf höchstens so viele Aufträge — jeder braucht einen Shopify-Abruf. */
const NACHZIEHEN_JE_LAUF = 30

export async function shopifyPreiseNachziehen(): Promise<AktionsErgebnis> {
  const { fetchOrder } = await import('../../integrationen/shopify.ts')
  const { positionsPreis, versandNetto } = await import('../../integrationen/import.ts')
  const offen = await sql<{ id: string; gid: string; name: string | null }[]>`
    select id, shopify_order_id as gid, shopify_order_name as name
    from sales_orders
    where source = 'shopify' and shopify_order_id is not null
      and not (zusatz ? 'netto_0089')
      and not (historisch and number = shopify_order_name)   -- CSV-Historie ist schon netto
    order by order_date desc
    limit ${NACHZIEHEN_JE_LAUF}`

  let neu = 0
  const fehler: string[] = []
  for (const auftrag of offen) {
    try {
      const order = await fetchOrder(auftrag.gid)
      if (order) {
        await tx(async (t) => {
          for (const item of order.lineItems.nodes) {
            const preis = positionsPreis(item, order.taxesIncluded)
            const [variante] = await t<{ id: string }[]>`
              select id from product_variants
              where (${item.variant?.id ?? null}::text is not null and shopify_variant_id = ${item.variant?.id ?? null})
                 or (${item.sku}::text is not null and sku = ${item.sku})
              limit 1`
            if (!variante) continue
            await t`
              update sales_order_lines
              set price_unit = ${preis.stueckNetto}, tax_rate = ${preis.steuersatz}, discount = 0
              where order_id = ${auftrag.id} and variant_id = ${variante.id}`
          }
          await t`
            update sales_orders
            set versandkosten = ${versandNetto(order)},
                zusatz = zusatz || '{"netto_0089": true}'::jsonb
            where id = ${auftrag.id}`
        })
        neu++
      } else {
        await sql`update sales_orders set zusatz = zusatz || '{"netto_0089": "nicht im Shop"}'::jsonb
                  where id = ${auftrag.id}`
      }
    } catch (err) {
      fehler.push(`${auftrag.name ?? auftrag.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const [{ rest }] = await sql<{ rest: number }[]>`
    select count(*)::int as rest from sales_orders
    where source = 'shopify' and shopify_order_id is not null
      and not (zusatz ? 'netto_0089')
      and not (historisch and number = shopify_order_name)`
  return {
    text:
      `${neu} Auftrag/Aufträge auf Netto-Preise gesetzt` +
      (rest > 0 ? `, ${rest} offen — erneut ausführen` : ', alle erledigt') +
      (fehler.length ? ` — Fehler: ${fehler.slice(0, 2).join(' | ')}` : '') + '.',
  }
}
