import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { barcodePngDataUri } from '@/modules/shared/barcode'
import { date, qty } from '@/modules/shared/format'
import { moZettelDaten } from './zettel-daten'

/**
 * Der Fertigungszettel als PDF — für die Druckbrücke (der Agent am
 * Fertigungs-PC druckt still auf A4). Gleiche Daten und gleicher Aufbau
 * wie die Browser-Druckseite /fertigung/[id]/druck: Kopf mit FERTIGUNG-
 * und VERSAND-Barcode, Artikel-Code, eingefrorene Komponentenliste zum
 * Abhaken, Unterschriftszeile. Barcodes als PNG (react-pdf kann kein SVG
 * aus bwip-js einbetten).
 */

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica' },
  kopf: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  titel: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  firma: { fontSize: 9, marginTop: 2 },
  codes: { flexDirection: 'row', gap: 14 },
  codeBlock: { alignItems: 'center' },
  codeBild: { height: 44 },
  codeLabel: { fontSize: 7, fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginTop: 2 },
  tabelle: { marginTop: 14 },
  zeile: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#999', paddingVertical: 3 },
  th: { width: '25%', fontFamily: 'Helvetica-Bold' },
  gross: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 16, marginBottom: 4 },
  kopfzeile: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#000', paddingVertical: 3, fontFamily: 'Helvetica-Bold' },
  cCheck: { width: 24 },
  cName: { flex: 1 },
  cSku: { width: 110, fontFamily: 'Courier', fontSize: 9 },
  cMenge: { width: 60, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
  cEinheit: { width: 50, paddingLeft: 6 },
  notiz: { marginTop: 14 },
  unterschriften: { flexDirection: 'row', gap: 30, marginTop: 30 },
  unterschrift: { flex: 1, borderTopWidth: 1, borderTopColor: '#000', paddingTop: 3, fontSize: 9 },
})

async function codeBlock(wert: string, label: string, hoehe = 12) {
  return { uri: await barcodePngDataUri(wert, { height: hoehe, scale: 3 }), label }
}

/** Rendert die Zettel der übergebenen Fertigungsaufträge als EIN PDF (eine Seite je Auftrag). */
export async function moZettelPdf(moIds: string[]): Promise<Buffer> {
  const seiten = []
  for (const id of moIds) {
    const daten = await moZettelDaten(id)
    if (!daten) continue
    const fertigung = await codeBlock(daten.mo.number, 'FERTIGUNG')
    const versand = daten.lieferung ? await codeBlock(daten.lieferung, 'VERSAND') : null
    const artikelWert = daten.mo.barcode ?? daten.mo.sku
    const artikel = artikelWert
      ? await barcodePngDataUri(artikelWert, { height: 9, scale: 2 })
      : null
    seiten.push({ daten, fertigung, versand, artikel })
  }
  if (seiten.length === 0) throw new Error('Keiner der Fertigungsaufträge wurde gefunden.')

  const dokument = (
    <Document>
      {seiten.map(({ daten, fertigung, versand, artikel }) => (
        <Page key={daten.mo.number} size="A4" style={s.page}>
          <View style={s.kopf}>
            <View>
              <Text style={s.titel}>Fertigungsauftrag {daten.mo.number}</Text>
              {daten.firma && <Text style={s.firma}>{daten.firma}</Text>}
            </View>
            <View style={s.codes}>
              <View style={s.codeBlock}>
                <Image style={s.codeBild} src={fertigung.uri} />
                <Text style={s.codeLabel}>FERTIGUNG</Text>
              </View>
              {versand && (
                <View style={s.codeBlock}>
                  <Image style={s.codeBild} src={versand.uri} />
                  <Text style={s.codeLabel}>VERSAND</Text>
                </View>
              )}
            </View>
          </View>

          <View style={s.tabelle}>
            <View style={s.zeile}>
              <Text style={s.th}>Produkt</Text>
              <Text>
                {daten.mo.product}
                {daten.mo.sku ? ` · ${daten.mo.sku}` : ''}
              </Text>
            </View>
            {artikel && (
              <View style={s.zeile}>
                <Text style={s.th}>Artikel-Code</Text>
                <Image style={{ height: 30 }} src={artikel} />
              </View>
            )}
            <View style={s.zeile}>
              <Text style={s.th}>Menge</Text>
              <Text style={s.gross}>
                {qty(daten.mo.qty_to_produce)} {daten.mo.uom}
              </Text>
            </View>
            <View style={s.zeile}>
              <Text style={s.th}>Termin</Text>
              <Text>{date(daten.mo.scheduled_date as string)}</Text>
            </View>
            {daten.mo.sales_order_number && (
              <View style={s.zeile}>
                <Text style={s.th}>Verkaufsauftrag</Text>
                <Text>
                  {daten.mo.sales_order_number}
                  {daten.mo.shopify_order_name ? ` (${daten.mo.shopify_order_name})` : ''}
                  {daten.mo.customer ? ` · ${daten.mo.customer}` : ''}
                </Text>
              </View>
            )}
          </View>

          <Text style={s.h2}>Komponenten</Text>
          <View style={s.kopfzeile}>
            <Text style={s.cCheck}> </Text>
            <Text style={s.cName}>Komponente</Text>
            <Text style={s.cSku}>Artikelnr.</Text>
            <Text style={s.cMenge}>Menge</Text>
            <Text style={s.cEinheit}>Einheit</Text>
          </View>
          {daten.components.map((c) => (
            <View key={c.id} style={s.zeile}>
              <Text style={s.cCheck}>[  ]</Text>
              <Text style={s.cName}>{c.product}</Text>
              <Text style={s.cSku}>{c.sku ?? '—'}</Text>
              <Text style={s.cMenge}>{qty(c.qty)}</Text>
              <Text style={s.cEinheit}>{c.uom}</Text>
            </View>
          ))}

          {daten.mo.note && (
            <Text style={s.notiz}>
              <Text style={{ fontFamily: 'Helvetica-Bold' }}>Notizen: </Text>
              {daten.mo.note}
            </Text>
          )}

          <View style={s.unterschriften}>
            <Text style={s.unterschrift}>Gefertigt von / Datum</Text>
            <Text style={s.unterschrift}>Geprüft von / Datum</Text>
          </View>
        </Page>
      ))}
    </Document>
  )

  return Buffer.from(await renderToBuffer(dokument))
}
