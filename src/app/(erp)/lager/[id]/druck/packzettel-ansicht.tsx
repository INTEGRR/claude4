import { barcodeSvg, code128 } from '@/modules/shared/barcode'
import { qty } from '@/modules/shared/format'
import type { Packzettel } from '@/modules/versand/packzettel-daten'

/**
 * Ein Packzettel als Druckseite — der VERSAND-Barcode öffnet die Lieferung
 * am Packtisch, die Positionen tragen je Zeile den Artikel-Code zum
 * Gegenscannen und ein Kästchen zum Abhaken beim Kommissionieren.
 * Gleiche Daten wie das PDF der Druckbrücke (packzettel-daten.ts).
 */
export function PackzettelAnsicht({ zettel }: { zettel: Packzettel }) {
  const { kopf, zeilen, firma } = zettel
  return (
    <div className="print-doc">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
        <div>
          <h1>Packzettel {kopf.number}</h1>
          <div style={{ fontSize: 13 }}>{firma}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div
            className="barcode"
            aria-label={`Versand ${kopf.number}`}
            dangerouslySetInnerHTML={{ __html: code128(kopf.number) }}
          />
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 2 }}>VERSAND</div>
        </div>
      </div>

      <table style={{ marginTop: 16, marginBottom: 20 }}>
        <tbody>
          {kopf.sales_order_number && (
            <tr>
              <th style={{ width: '25%' }}>Auftrag</th>
              <td>
                {kopf.sales_order_number}
                {kopf.shopify_order_name && ` (${kopf.shopify_order_name})`}
                {kopf.customer && ` · ${kopf.customer}`}
              </td>
            </tr>
          )}
          {!kopf.sales_order_number && kopf.origin_label && (
            <tr>
              <th style={{ width: '25%' }}>Herkunft</th>
              <td>{kopf.origin_label}</td>
            </tr>
          )}
          {kopf.ship_name && (
            <tr>
              <th>Lieferadresse</th>
              <td>
                {kopf.ship_name}
                {' · '}
                {kopf.ship_street} {kopf.ship_house_number}, {kopf.ship_zip} {kopf.ship_city}
                {kopf.ship_country_code && kopf.ship_country_code !== 'DE' ? ` (${kopf.ship_country_code})` : ''}
              </td>
            </tr>
          )}
          {kopf.kundennotiz && (
            <tr>
              <th>Hinweis</th>
              <td>{kopf.kundennotiz}</td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ fontSize: 15, marginBottom: 6 }}>Positionen</h2>
      <table>
        <thead>
          <tr>
            <th style={{ width: 34 }}>✓</th>
            <th>Artikel</th>
            <th>Artikel-Code</th>
            <th style={{ textAlign: 'right', width: 90 }}>Menge</th>
            <th style={{ width: 70 }}>Einheit</th>
          </tr>
        </thead>
        <tbody>
          {zeilen.map((l) => (
            <tr key={l.id}>
              <td style={{ textAlign: 'center' }}>☐</td>
              <td>
                {l.product}
                {l.belegtext && <div style={{ fontSize: 11 }}>{l.belegtext}</div>}
              </td>
              <td>
                {l.barcode || l.sku ? (
                  <span
                    className="barcode"
                    aria-label={`Artikel ${l.barcode ?? l.sku}`}
                    dangerouslySetInnerHTML={{
                      __html: barcodeSvg(l.barcode ?? l.sku ?? '', { height: 8, scale: 2 }),
                    }}
                  />
                ) : (
                  '—'
                )}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty(l.qty)}</td>
              <td>{l.uom}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 32, display: 'flex', gap: 40, fontSize: 12 }}>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Gesammelt von / Datum</div>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Gepackt von / Datum</div>
      </div>
    </div>
  )
}
