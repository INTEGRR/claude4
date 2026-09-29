import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { barcodePngDataUri } from '@/modules/shared/barcode'
import { qty } from '@/modules/shared/format'
import { packzettelDaten } from './packzettel-daten'

/**
 * Der Packzettel als PDF (A4) für die Druckbrücke — gleiche Daten und
 * gleicher Aufbau wie die Druckseite (packzettel-ansicht.tsx): VERSAND-
 * Barcode, Auftrag, Lieferadresse, Positionen mit Artikel-Code und
 * Abhak-Kästchen, Unterschriften für Sammeln und Packen (0091).
 */

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica' },
  kopf: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  titel: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  firma: { fontSize: 9, marginTop: 2 },
  codeBlock: { alignItems: 'center' },
  codeBild: { height: 44 },
  codeLabel: { fontSize: 7, fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginTop: 2 },
  tabelle: { marginTop: 14 },
  zeile: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#999', paddingVertical: 3 },
  th: { width: '25%', fontFamily: 'Helvetica-Bold' },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 16, marginBottom: 4 },
  kopfzeile: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#000', paddingVertical: 3, fontFamily: 'Helvetica-Bold' },
  pos: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#999', paddingVertical: 4, alignItems: 'center' },
  cCheck: { width: 24 },
  kaestchen: { width: 10, height: 10, borderWidth: 1, borderColor: '#000' },
  cName: { flex: 1 },
  cCode: { width: 130 },
  codeKlein: { height: 22 },
  cMenge: { width: 60, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
  cEinheit: { width: 50, paddingLeft: 6 },
  belegtext: { fontSize: 8, color: '#333' },
  unterschriften: { flexDirection: 'row', gap: 30, marginTop: 30 },
  unterschrift: { flex: 1, borderTopWidth: 1, borderTopColor: '#000', paddingTop: 3, fontSize: 9 },
})

/** Rendert die Packzettel der Lieferungen als EIN PDF (eine Seite je Lieferung). */
export async function packzettelPdf(pickingIds: string[]): Promise<Buffer> {
  const zettel = await packzettelDaten(pickingIds)
  if (zettel.length === 0) throw new Error('Keine der Lieferungen wurde gefunden.')
  const seiten = []
  for (const z of zettel) {
    const versand = await barcodePngDataUri(z.kopf.number, { height: 12, scale: 3 })
    const codes: Record<string, string> = {}
    for (const l of z.zeilen) {
      const wert = l.barcode ?? l.sku
      if (wert) codes[l.id] = await barcodePngDataUri(wert, { height: 8, scale: 2 })
    }
    seiten.push({ z, versand, codes })
  }

  const dokument = (
    <Document>
      {seiten.map(({ z, versand, codes }) => (
        <Page key={z.kopf.id} size="A4" style={s.page}>
          <View style={s.kopf}>
            <View>
              <Text style={s.titel}>Packzettel {z.kopf.number}</Text>
              {z.firma && <Text style={s.firma}>{z.firma}</Text>}
            </View>
            <View style={s.codeBlock}>
              <Image style={s.codeBild} src={versand} />
              <Text style={s.codeLabel}>VERSAND</Text>
            </View>
          </View>

          <View style={s.tabelle}>
            {z.kopf.sales_order_number && (
              <View style={s.zeile}>
                <Text style={s.th}>Auftrag</Text>
                <Text>
                  {z.kopf.sales_order_number}
                  {z.kopf.shopify_order_name ? ` (${z.kopf.shopify_order_name})` : ''}
                  {z.kopf.customer ? ` · ${z.kopf.customer}` : ''}
                </Text>
              </View>
            )}
            {z.kopf.ship_name && (
              <View style={s.zeile}>
                <Text style={s.th}>Lieferadresse</Text>
                <Text>
                  {z.kopf.ship_name} · {z.kopf.ship_street} {z.kopf.ship_house_number}, {z.kopf.ship_zip}{' '}
                  {z.kopf.ship_city}
                  {z.kopf.ship_country_code && z.kopf.ship_country_code !== 'DE' ? ` (${z.kopf.ship_country_code})` : ''}
                </Text>
              </View>
            )}
            {z.kopf.kundennotiz && (
              <View style={s.zeile}>
                <Text style={s.th}>Hinweis</Text>
                <Text>{z.kopf.kundennotiz}</Text>
              </View>
            )}
          </View>

          <Text style={s.h2}>Positionen</Text>
          <View style={s.kopfzeile}>
            <Text style={s.cCheck}> </Text>
            <Text style={s.cName}>Artikel</Text>
            <Text style={s.cCode}>Artikel-Code</Text>
            <Text style={s.cMenge}>Menge</Text>
            <Text style={s.cEinheit}>Einheit</Text>
          </View>
          {z.zeilen.map((l) => (
            <View key={l.id} style={s.pos} wrap={false}>
              <View style={s.cCheck}>
                <View style={s.kaestchen} />
              </View>
              <View style={s.cName}>
                <Text>{l.product}</Text>
                {l.belegtext && <Text style={s.belegtext}>{l.belegtext}</Text>}
              </View>
              <View style={s.cCode}>
                {codes[l.id] ? <Image style={s.codeKlein} src={codes[l.id]} /> : <Text>—</Text>}
              </View>
              <Text style={s.cMenge}>{qty(l.qty)}</Text>
              <Text style={s.cEinheit}>{l.uom}</Text>
            </View>
          ))}

          <View style={s.unterschriften}>
            <Text style={s.unterschrift}>Gesammelt von / Datum</Text>
            <Text style={s.unterschrift}>Gepackt von / Datum</Text>
          </View>
        </Page>
      ))}
    </Document>
  )
  return renderToBuffer(dokument)
}
