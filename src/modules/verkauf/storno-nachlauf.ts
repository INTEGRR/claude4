import 'server-only'
import { sql } from '@/db/client'
import { cancelShipmentById } from '@/modules/versand/service'

/**
 * Nachlauf eines Auftrags-Stornos — der Teil, der nicht in die
 * Datenbank-Transaktion von cancel_sales_order passt, weil er DHL anruft
 * (Entscheidungslog 2026-10-02: Storno von Shop-Aufträgen führt Shopify,
 * KRNL zieht alles Nachgelagerte mit).
 *
 * - DHL-Labels stornierter Lieferungen, die noch nicht übergeben sind
 *   (Zustand „Label erstellt"), werden bei DHL storniert.
 * - Ist die Lieferung schon ausgebucht, das Paket aber noch nicht übergeben,
 *   liegt es womöglich noch im Haus: dann eine Aufgabe fürs Lager — nicht
 *   verschicken, Label stornieren, Ware per Retoure zurückbuchen. Automatisch
 *   zurückbuchen wäre zu viel: ob das Paket schon weg ist, weiß nur das Lager.
 *
 * Wirft nie: ein gescheiterter DHL-Storno steht als Fehler am Auftrag und
 * wird zur Aufgabe, der Storno selbst ist dann längst gebucht.
 */
export async function stornoNachlauf(
  auftragId: string,
  akteur: string,
): Promise<{ labelsStorniert: number; aufgaben: number }> {
  const sendungen = await sql<
    { id: string; shipment_number: string | null; lieferung_storniert: boolean; lieferung: string | null }[]
  >`
    select s.id, s.shipment_number, sp.state = 'cancel' as lieferung_storniert, sp.number as lieferung
    from shipments s
    join stock_pickings sp on sp.id = s.picking_id
    where sp.origin_model = 'sales_order' and sp.origin_id = ${auftragId}
      and s.state = 'created'`

  let labelsStorniert = 0
  const imHaus: string[] = []
  for (const s of sendungen) {
    if (!s.lieferung_storniert) {
      imHaus.push(`${s.lieferung ?? 'Lieferung'} (Sendung ${s.shipment_number ?? '—'})`)
      continue
    }
    try {
      await cancelShipmentById(s.id)
      labelsStorniert++
    } catch (fehler) {
      const text = fehler instanceof Error ? fehler.message : String(fehler)
      await sql`select log_event('sales_order', ${auftragId}, 'error',
        ${`DHL-Label ${s.shipment_number ?? ''} ließ sich nicht stornieren: ${text.slice(0, 200)}`}, ${akteur})`
      imHaus.push(`${s.lieferung ?? 'Lieferung'} (Label ${s.shipment_number ?? '—'} nicht storniert)`)
    }
  }
  if (labelsStorniert > 0) {
    await sql`select log_event('sales_order', ${auftragId}, 'note',
      ${`${labelsStorniert} DHL-Label(s) storniert.`}, ${akteur})`
  }

  if (imHaus.length === 0) return { labelsStorniert, aufgaben: 0 }

  const [auftrag] = await sql<{ number: string; shopify_order_name: string | null }[]>`
    select number, shopify_order_name from sales_orders where id = ${auftragId}`
  const name = auftrag?.shopify_order_name ? `${auftrag.number} (${auftrag.shopify_order_name})` : auftrag?.number
  const titel = `Storniert: Paket zu ${name} nicht verschicken`
  const beschreibung =
    `Der Auftrag wurde storniert, das Paket ist aber noch nicht übergeben: ${imHaus.join(', ')}. ` +
    'Liegt es noch hier: nicht verschicken, Label stornieren (Versand) und die Ware per Retoure zurückbuchen. ' +
    'Ist es schon unterwegs: Rücksendung mit dem Kunden klären.'
  // Eine Aufgabe je Auftrag — ein zweiter Webhook legt keine doppelte an.
  const [neu] = await sql<{ id: string }[]>`
    insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von)
    select ${titel}, ${beschreibung}, 'lager', (now() at time zone 'Europe/Berlin')::date, ${akteur}
    where not exists (select 1 from aufgaben where titel = ${titel} and status = 'offen')
    returning id`
  if (neu) {
    await sql`select log_event('sales_order', ${auftragId}, 'error',
      ${`Paket noch nicht übergeben — Aufgabe fürs Lager angelegt: ${titel}`}, ${akteur})`
  }
  return { labelsStorniert, aufgaben: neu ? 1 : 0 }
}
