import { createElement as h, type ReactElement } from 'react'
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { sql } from '@/db/client'

/**
 * Die Einkaufsbestellung als PDF (0094) — Anhang der Bestell-Mail an den
 * Lieferanten und Ablage im Bestellordner. Englisch für ausländische
 * Lieferanten (auch chinesische: Hanzi bräuchten eine eingebettete Schrift,
 * Englisch versteht jede Exportabteilung), Deutsch für deutsche.
 * Bewusst ohne JSX (`createElement`), damit die Prozesstests unter blankem
 * Node denselben Code rendern wie die App.
 */

type PdfSprache = 'de' | 'en'

const T: Record<PdfSprache, Record<string, string>> = {
  de: {
    titel: 'Bestellung', nummer: 'Bestellnummer', datum: 'Datum', lieferant: 'Lieferant', lieferadresse: 'Lieferadresse',
    waehrung: 'Währung', incoterm: 'Lieferbedingung', zahlung: 'Zahlungsbedingung', termin: 'Gewünschter Liefertermin',
    pos: 'Pos.', artikel: 'Artikel', artnr: 'Art.-Nr. Lieferant', menge: 'Menge', preis: 'Einzelpreis', summe: 'Betrag',
    netto: 'Summe netto', hinweis: 'Bitte geben Sie unsere Bestellnummer auf Proforma-Rechnung, Rechnung, Packliste und Paketen an.',
    ust: 'USt-IdNr.', eori: 'EORI', ansprech: 'Ansprechpartner', notiz: 'Hinweise',
  },
  en: {
    titel: 'Purchase Order', nummer: 'PO number', datum: 'Date', lieferant: 'Supplier', lieferadresse: 'Delivery address',
    waehrung: 'Currency', incoterm: 'Incoterm', zahlung: 'Payment terms', termin: 'Requested delivery date',
    pos: 'Pos.', artikel: 'Item', artnr: 'Supplier part no.', menge: 'Qty', preis: 'Unit price', summe: 'Amount',
    netto: 'Total (net)', hinweis: 'Please state our PO number on proforma invoice, invoice, packing list and all cartons.',
    ust: 'VAT ID', eori: 'EORI', ansprech: 'Contact', notiz: 'Notes',
  },
}

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 9.5, fontFamily: 'Helvetica', color: '#111' },
  kopf: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  firma: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
  klein: { fontSize: 8.5, color: '#333', marginTop: 1 },
  titel: { fontSize: 18, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  nummer: { fontSize: 11, textAlign: 'right', marginTop: 2 },
  bloecke: { flexDirection: 'row', gap: 20, marginBottom: 14 },
  block: { flex: 1 },
  label: { fontSize: 7.5, color: '#666', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  daten: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 14, borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: '#999', paddingVertical: 6 },
  datum: { width: '33%', marginVertical: 2 },
  kopfzeile: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#000', paddingVertical: 3, fontFamily: 'Helvetica-Bold' },
  zeile: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#bbb', paddingVertical: 4 },
  cPos: { width: 28 },
  cArtikel: { flex: 1, paddingRight: 6 },
  cArtnr: { width: 90 },
  cMenge: { width: 55, textAlign: 'right' },
  cPreis: { width: 70, textAlign: 'right' },
  cSumme: { width: 75, textAlign: 'right' },
  summe: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6, fontFamily: 'Helvetica-Bold', fontSize: 11 },
  hinweis: { marginTop: 22, fontSize: 8.5, color: '#333' },
  fuss: { position: 'absolute', bottom: 24, left: 40, right: 40, fontSize: 7.5, color: '#777', textAlign: 'center' },
})

interface Firma {
  name?: string
  street?: string
  house?: string
  zip?: string
  city?: string
  country?: string
  email?: string
  phone?: string
  ust_id?: string
  eori?: string
}

function zahl(wert: number, stellen: { min: number; max: number }, sprache: PdfSprache): string {
  return wert.toLocaleString(sprache === 'de' ? 'de-DE' : 'en-US', {
    minimumFractionDigits: stellen.min,
    maximumFractionDigits: stellen.max,
  })
}

function datumText(wert: string | null, sprache: PdfSprache): string {
  if (!wert) return '—'
  const d = new Date(wert)
  return sprache === 'de'
    ? d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })
    : d.toISOString().slice(0, 10)
}

export async function bestellungPdf(poId: string): Promise<{ bytes: Buffer; dateiname: string; sprache: PdfSprache }> {
  const [po] = await sql<
    {
      number: string
      created_at: string
      currency: string
      incoterm_code: string | null
      zahlung: string | null
      termin: string | null
      note: string | null
      einkaeufer: string | null
      einkaeufer_email: string | null
      lieferant: string
      l_street: string | null
      l_house: string | null
      l_zip: string | null
      l_city: string | null
      l_country: string | null
      sprache: string | null
      lager: string | null
    }[]
  >`
    select po.number, po.created_at::text, po.currency, po.incoterm_code, pt.name as zahlung,
           coalesce(po.eta_confirmed::timestamptz, po.expected_arrival, po.order_deadline)::text as termin,
           po.note, u.name as einkaeufer, u.email as einkaeufer_email,
           p.name as lieferant, p.street as l_street, p.house_number as l_house, p.zip as l_zip, p.city as l_city,
           p.country_code as l_country, p.sprache,
           (select w.name from warehouses w order by w.created_at limit 1) as lager
    from purchase_orders po
    join partners p on p.id = po.vendor_id
    left join users u on u.id = po.user_id
    left join payment_terms pt on pt.id = po.payment_term_id
    where po.id = ${poId}`
  if (!po) throw new Error('Bestellung nicht gefunden')
  const zeilen = await sql<{ name: string; artnr: string | null; qty: number; einheit: string; preis: number; rabatt: number }[]>`
    select l.name, vp.vendor_product_code as artnr, l.qty::float as qty, uo.name as einheit,
           l.price_unit::float as preis, coalesce(l.discount, 0)::float as rabatt
    from purchase_order_lines l
    join uoms uo on uo.id = l.uom_id
    join product_variants pv on pv.id = l.variant_id
    left join lateral (
      select vendor_product_code from vendor_prices v
      where v.template_id = pv.template_id and v.vendor_id = (select vendor_id from purchase_orders where id = ${poId})
        and v.vendor_product_code is not null
      order by v.min_qty limit 1
    ) vp on true
    where l.order_id = ${poId}
    order by l.sequence, l.created_at`
  const [firmaZeile] = await sql<{ value: Firma | null }[]>`select value from settings where key = 'company'`
  const f = firmaZeile?.value ?? {}

  const sprache: PdfSprache = po.sprache === 'de' || (!po.sprache && po.l_country === 'DE') ? 'de' : 'en'
  const t = T[sprache]
  const betrag = (z: { qty: number; preis: number; rabatt: number }) => z.qty * z.preis * (1 - z.rabatt / 100)
  const netto = zeilen.reduce((a, z) => a + betrag(z), 0)
  const firmaAdresse = [[f.street, f.house].filter(Boolean).join(' '), [f.zip, f.city].filter(Boolean).join(' '), f.country]
    .filter(Boolean)
    .join(' · ')

  const zelle = (style: (typeof s)[keyof typeof s], text: string) => h(Text, { style }, text)
  const datum = (label: string, wert: string) =>
    h(View, { style: s.datum }, h(Text, { style: s.label }, label), h(Text, null, wert))

  const seite = h(
    Page,
    { size: 'A4', style: s.page },
    h(
      View,
      { style: s.kopf },
      h(
        View,
        null,
        h(Text, { style: s.firma }, f.name ?? ''),
        h(Text, { style: s.klein }, firmaAdresse),
        h(Text, { style: s.klein }, [f.email, f.phone].filter(Boolean).join(' · ')),
        h(Text, { style: s.klein }, [f.ust_id && `${t.ust} ${f.ust_id}`, f.eori && `${t.eori} ${f.eori}`].filter(Boolean).join(' · ')),
      ),
      h(View, null, h(Text, { style: s.titel }, t.titel), h(Text, { style: s.nummer }, po.number)),
    ),
    h(
      View,
      { style: s.bloecke },
      h(
        View,
        { style: s.block },
        h(Text, { style: s.label }, t.lieferant),
        h(Text, { style: { fontFamily: 'Helvetica-Bold' } }, po.lieferant),
        h(Text, null, [po.l_street, po.l_house].filter(Boolean).join(' ')),
        h(Text, null, [po.l_zip, po.l_city, po.l_country].filter(Boolean).join(' ')),
      ),
      h(
        View,
        { style: s.block },
        h(Text, { style: s.label }, t.lieferadresse),
        h(Text, { style: { fontFamily: 'Helvetica-Bold' } }, f.name ?? ''),
        h(Text, null, [f.street, f.house].filter(Boolean).join(' ')),
        h(Text, null, [f.zip, f.city, f.country].filter(Boolean).join(' ')),
      ),
    ),
    h(
      View,
      { style: s.daten },
      datum(t.nummer, po.number),
      datum(t.datum, datumText(po.created_at, sprache)),
      datum(t.waehrung, po.currency),
      datum(t.incoterm, po.incoterm_code ?? '—'),
      datum(t.zahlung, po.zahlung ?? '—'),
      datum(t.termin, datumText(po.termin, sprache)),
      datum(t.ansprech, [po.einkaeufer, po.einkaeufer_email].filter(Boolean).join(' · ') || '—'),
    ),
    h(
      View,
      { style: s.kopfzeile },
      zelle(s.cPos, t.pos),
      zelle(s.cArtikel, t.artikel),
      zelle(s.cArtnr, t.artnr),
      zelle(s.cMenge, t.menge),
      zelle(s.cPreis, t.preis),
      zelle(s.cSumme, t.summe),
    ),
    ...zeilen.map((z, i) =>
      h(
        View,
        { key: String(i), style: s.zeile, wrap: false },
        zelle(s.cPos, String(i + 1)),
        zelle(s.cArtikel, z.name + (z.rabatt ? ` (−${zahl(z.rabatt, { min: 0, max: 2 }, sprache)} %)` : '')),
        zelle(s.cArtnr, z.artnr ?? ''),
        zelle(s.cMenge, `${zahl(z.qty, { min: 0, max: 4 }, sprache)} ${z.einheit}`),
        zelle(s.cPreis, zahl(z.preis, { min: 2, max: 6 }, sprache)),
        zelle(s.cSumme, zahl(betrag(z), { min: 2, max: 2 }, sprache)),
      ),
    ),
    h(View, { style: s.summe }, h(Text, null, `${t.netto}: ${zahl(netto, { min: 2, max: 2 }, sprache)} ${po.currency}`)),
    po.note ? h(View, { style: { marginTop: 14 } }, h(Text, { style: s.label }, t.notiz), h(Text, null, po.note)) : null,
    h(Text, { style: s.hinweis }, t.hinweis),
    h(Text, { style: s.fuss, fixed: true }, `${f.name ?? ''} · ${po.number}`),
  )
  const dokument = h(Document, { title: `${t.titel} ${po.number}`, author: f.name ?? 'KRNL' }, seite) as ReactElement
  // renderToBuffer erwartet ein <Document>-Element — createElement liefert genau das.
  const bytes = await renderToBuffer(dokument as Parameters<typeof renderToBuffer>[0])
  return { bytes, dateiname: `${po.number}.pdf`, sprache }
}
