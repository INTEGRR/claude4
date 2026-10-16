import { createElement as h, type ReactElement } from 'react'
import { Document, Image, Page, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { sql } from '@/db/client'
import { LABELS } from '@/modules/shared/format'
import { barcodePngDataUri } from '@/modules/shared/barcode'
import {
  type Anschrift,
  type Firma,
  absenderZeile,
  anschriftZeilen,
  belegFuss,
  belegStile as s,
  datenZeile,
  datum,
  firmaLaden,
  geld,
  menge,
  r2,
  seitenzahl,
} from '@/modules/shared/beleg-pdf'

/**
 * Reparaturauftrag als Ausdruck (Entscheidungslog 2026-10-16): ein Blatt je
 * Auftrag, das in die Werkstatt und zum Kunden passt — RMA-Nummer als
 * Barcode (der Scanner führt zum Auftrag), Kunde, Gerät mit Seriennummer,
 * Fehlerbild, Teile mit Preisen bei kostenpflichtigen Aufträgen, Verlauf
 * nach dem Abschluss, Felder für Befund und Unterschriften. Vor dem
 * Abschluss heißt das Blatt „Reparaturauftrag", danach „Reparaturbericht".
 */

export interface ReparaturDaten {
  id: string
  number: string
  state: string
  scheduled_date: string
  created_at: string
  received_at: string | null
  under_warranty: boolean
  priority: string
  qty: number
  note: string | null
  product: string
  sku: string | null
  lot_name: string | null
  origin_label: string | null
  sales_order_number: string | null
  verantwortlich: string | null
  kundennummer: string | null
  anschrift: Anschrift
  email: string | null
  phone: string | null
  ruecksendung: string | null
  retourenlabel: string | null
}

export interface ReparaturTeil {
  part_type: 'add' | 'remove' | 'recycle'
  product: string
  qty: number
  qty_done: number
  uom: string
  price_unit: number
  gebucht: boolean
}

export interface ReparaturEreignis {
  am: string
  text: string
}

const TEILART: Record<ReparaturTeil['part_type'], string> = {
  add: 'Einbau',
  remove: 'Ausbau (Entsorgung)',
  recycle: 'Ausbau (wiederverwendet)',
}

const ABGESCHLOSSEN = ['repaired', 'shipped']

export function reparaturTitel(state: string): string {
  if (state === 'cancel') return 'Reparaturauftrag — storniert'
  return ABGESCHLOSSEN.includes(state) ? 'Reparaturbericht' : 'Reparaturauftrag'
}

/** Nettosumme der Einbauteile — nur bei kostenpflichtigen Aufträgen von Belang. */
export function teileSumme(teile: ReparaturTeil[]): number {
  return r2(teile.filter((t) => t.part_type === 'add').reduce((sum, t) => sum + r2(Number(t.qty) * Number(t.price_unit)), 0))
}

function abschnitt(titel: string, ...kinder: (ReactElement | null)[]): ReactElement {
  return h(
    View,
    { style: { marginTop: 10 } },
    h(Text, { style: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginBottom: 5 } }, titel),
    ...kinder.filter(Boolean),
  )
}

function feld(label: string, wert: string | null | undefined): ReactElement {
  return h(
    View,
    { style: { width: '50%', flexDirection: 'row', marginBottom: 3 } },
    h(Text, { style: { width: 90, fontSize: 8, color: '#444' } }, label),
    h(Text, { style: { flex: 1, fontSize: 9 } }, wert || '—'),
  )
}

function linien(anzahl: number): ReactElement[] {
  return Array.from({ length: anzahl }, (_, i) =>
    h(View, { key: String(i), style: { borderBottomWidth: 0.5, borderBottomColor: '#999', height: 16 } }),
  )
}

export function reparaturDokument(
  d: ReparaturDaten,
  teile: ReparaturTeil[],
  verlauf: ReparaturEreignis[],
  firma: Firma,
  barcode: string | null,
): ReactElement {
  const titel = reparaturTitel(d.state)
  const fertig = ABGESCHLOSSEN.includes(d.state)
  const kostenpflichtig = !d.under_warranty
  const zeigePreise = kostenpflichtig && teile.some((t) => t.part_type === 'add' && Number(t.price_unit) > 0)

  const kopf = h(
    View,
    { style: s.kopf },
    h(View, { style: s.anschriftBlock },
      h(Text, { style: s.marke }, (firma.name ?? 'KRNL').toUpperCase()),
      h(Text, { style: { ...s.absender, marginTop: 26 } }, absenderZeile(firma)),
      h(View, { style: s.anschrift }, ...anschriftZeilen(d.anschrift).map((z, i) => h(Text, { key: String(i) }, z))),
      d.email || d.phone
        ? h(Text, { style: { ...s.klein, marginTop: 4 } }, [d.email, d.phone].filter(Boolean).join(' · '))
        : null,
    ),
    h(View, { style: { ...s.daten, marginTop: 44 } },
      datenZeile('RMA-Nr.', d.number, true),
      datenZeile('Datum', datum(d.scheduled_date)),
      datenZeile('Status', LABELS.repair[d.state as keyof typeof LABELS.repair] ?? d.state),
      d.origin_label ? datenZeile('Anfrage', d.origin_label) : null,
      d.received_at ? datenZeile('Gerät eingegangen', datum(d.received_at)) : null,
      d.sales_order_number ? datenZeile('Angebot', d.sales_order_number) : null,
      h(View, { style: { height: 6 } }),
      d.kundennummer ? datenZeile('Ihre Kundennummer', d.kundennummer) : null,
      d.verantwortlich ? datenZeile('Ihr Ansprechpartner', d.verantwortlich) : null,
      barcode ? h(Image, { src: barcode, style: { width: 150, marginTop: 6, alignSelf: 'flex-end' } }) : null,
    ),
  )

  const geraet = abschnitt(
    'Gerät',
    h(View, { style: { flexDirection: 'row', flexWrap: 'wrap' } },
      feld('Produkt', d.product),
      feld('Artikelnummer', d.sku),
      feld('Menge', menge(Number(d.qty)).replace(/,00$/, '')),
      feld('Seriennummer', d.lot_name),
      feld('Abrechnung', d.under_warranty ? 'Garantie / Gewährleistung' : 'kostenpflichtig'),
      feld('Priorität', d.priority === '1' ? 'dringend' : 'normal'),
      d.retourenlabel ? feld('Retourenlabel', d.retourenlabel) : null,
      d.ruecksendung ? feld('Rücksendung', d.ruecksendung) : null,
    ),
  )

  const fehlerbild = abschnitt(
    'Fehlerbild',
    h(Text, { style: { fontSize: 9.5, lineHeight: 1.4 } }, d.note?.trim() || 'Keine Beschreibung hinterlegt.'),
  )

  const teileTabelle = abschnitt(
    'Teile',
    teile.length === 0
      ? h(Text, { style: s.klein }, fertig ? 'Keine Teile verbaut.' : 'Noch keine Teile erfasst.')
      : h(View, null,
          h(View, { style: s.kopfzeile },
            h(Text, { style: s.cPos }, 'Pos.'),
            h(Text, { style: s.cText }, 'Teil'),
            h(Text, { style: { width: 110 } }, 'Art'),
            h(Text, { style: s.cMenge }, fertig ? 'Gebucht' : 'Menge'),
            zeigePreise ? h(Text, { style: s.cPreis }, 'Einzelpreis') : null,
            zeigePreise ? h(Text, { style: s.cSumme }, 'Gesamt netto') : null),
          ...teile.map((t, i) => {
            const m = fertig && t.gebucht ? Number(t.qty_done) : Number(t.qty)
            return h(View, { key: String(i), style: s.zeile, wrap: false },
              h(Text, { style: s.cPos }, `${i + 1}.`),
              h(Text, { style: { ...s.cText, ...s.fett } }, t.product),
              h(Text, { style: { width: 110 } }, TEILART[t.part_type]),
              h(Text, { style: s.cMenge }, `${menge(m).replace(/,00$/, '')} ${t.uom}`),
              zeigePreise ? h(Text, { style: s.cPreis }, t.part_type === 'add' ? geld(Number(t.price_unit)) : '—') : null,
              zeigePreise ? h(Text, { style: s.cSumme }, t.part_type === 'add' ? geld(r2(m * Number(t.price_unit))) : '—') : null)
          }),
          zeigePreise
            ? h(View, { style: s.summen },
                h(View, { style: { ...s.summeZeile, ...s.summeGrau } },
                  h(Text, { style: { ...s.summeLabel, ...s.fett } }, 'Teile netto'),
                  h(Text, { style: { ...s.summeWert, ...s.fett } }, geld(teileSumme(teile.map((t) => ({ ...t, qty: fertig && t.gebucht ? t.qty_done : t.qty })))))),
                h(Text, { style: { ...s.klein, marginTop: 4 } }, 'zzgl. Arbeitszeit und Umsatzsteuer — verbindlich ist das Angebot bzw. die Rechnung.'))
            : null),
  )

  const verlaufBlock = fertig && verlauf.length > 0
    ? abschnitt('Verlauf', ...verlauf.map((e, i) =>
        h(View, { key: String(i), style: { flexDirection: 'row', marginBottom: 2 } },
          h(Text, { style: { width: 70, fontSize: 8.5, color: '#444' } }, datum(e.am)),
          h(Text, { style: { flex: 1, fontSize: 9 } }, e.text))))
    : null

  const befund = abschnitt(
    'Befund und durchgeführte Arbeiten',
    h(View, { style: { marginTop: 2 } }, ...linien(fertig ? 2 : 5)),
  )

  const unterschriften = h(
    View,
    { style: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 22 }, wrap: false },
    h(View, { style: { width: '44%' } },
      h(View, { style: { borderBottomWidth: 0.5, borderBottomColor: '#111', height: 18 } }),
      h(Text, { style: { ...s.klein, marginTop: 3 } }, 'Datum, Unterschrift Werkstatt')),
    h(View, { style: { width: '44%' } },
      h(View, { style: { borderBottomWidth: 0.5, borderBottomColor: '#111', height: 18 } }),
      h(Text, { style: { ...s.klein, marginTop: 3 } }, fertig ? 'Datum, Unterschrift Kunde (Gerät erhalten)' : 'Datum, Unterschrift Kunde (Gerät übergeben)')),
  )

  const hinweis = kostenpflichtig && !fertig
    ? h(Text, { style: s.hinweis }, 'Kostenpflichtige Reparatur: Teile und Arbeitszeit werden nach Abschluss angeboten bzw. berechnet. Ohne Auftrag erfolgt keine Reparatur.')
    : d.under_warranty
      ? h(Text, { style: s.hinweis }, 'Reparatur im Rahmen der Gewährleistung — für Sie entstehen keine Kosten, sofern kein Fremdverschulden festgestellt wird.')
      : null

  const seite = h(
    Page,
    { size: 'A4', style: s.page },
    kopf,
    h(Text, { style: { ...s.titel, marginTop: 4, marginBottom: 6 } }, titel),
    geraet,
    fehlerbild,
    teileTabelle,
    verlaufBlock,
    befund,
    hinweis,
    unterschriften,
    belegFuss(firma),
    seitenzahl(),
  )
  return h(Document, { title: `${titel} ${d.number}`, author: firma.name ?? 'KRNL' }, seite) as ReactElement
}

/** Lädt Auftrag, Teile, Verlauf und Firmendaten und rendert das PDF. */
export async function reparaturPdf(id: string): Promise<{ bytes: Buffer; dateiname: string; daten: ReparaturDaten }> {
  const [d] = await sql<ReparaturDaten[]>`
    select r.id, r.number, r.state::text as state, r.scheduled_date::text as scheduled_date,
           r.created_at::text as created_at, r.received_at::text as received_at, r.under_warranty, r.priority,
           r.qty, r.note, variant_display_name(r.variant_id) as product, pv.sku, sl.name as lot_name,
           r.origin_label, so.number as sales_order_number, u.name as verantwortlich,
           nullif(p.ref, '') as kundennummer,
           jsonb_build_object('name', p.name, 'street', p.street, 'house', p.house_number, 'street2', p.street2,
                              'zip', p.zip, 'city', p.city, 'country', p.country_code) as anschrift,
           p.email, p.phone,
           (select sh.shipment_number from shipments sh where sh.repair_order_id = r.id and sh.state <> 'cancelled'
             order by sh.created_at desc limit 1) as ruecksendung,
           (select rl.shipment_number from return_labels rl where rl.repair_order_id = r.id
             order by rl.created_at desc limit 1) as retourenlabel
    from repair_orders r
    join partners p on p.id = r.partner_id
    join product_variants pv on pv.id = r.variant_id
    left join stock_lots sl on sl.id = r.lot_id
    left join sales_orders so on so.id = r.sales_order_id
    left join users u on u.id = r.user_id
    where r.id = ${id}`
  if (!d) throw new Error('Reparaturauftrag nicht gefunden')
  const teile = await sql<ReparaturTeil[]>`
    select rp.part_type::text as part_type, variant_display_name(rp.variant_id) as product, rp.qty, rp.qty_done,
           u.name as uom, rp.price_unit, coalesce(m.state = 'done', false) as gebucht
    from repair_parts rp
    join uoms u on u.id = rp.uom_id
    left join stock_moves m on m.id = rp.move_id
    where rp.repair_id = ${id} order by rp.sequence`
  const verlauf = await sql<ReparaturEreignis[]>`
    select created_at::text as am, message as text from audit_log
    where model = 'repair_order' and record_id = ${id} and kind = 'state'
    order by created_at limit 20`
  const [firma, barcode] = await Promise.all([firmaLaden(), barcodePngDataUri(d.number, { height: 9, scale: 2 })])
  const dokument = reparaturDokument(d, teile, verlauf, firma, barcode)
  const bytes = await renderToBuffer(dokument as Parameters<typeof renderToBuffer>[0])
  return { bytes, dateiname: `${d.number.replace(/[^\w.-]+/g, '-')}.pdf`, daten: d }
}
