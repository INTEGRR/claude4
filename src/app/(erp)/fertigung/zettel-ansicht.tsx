import { barcodeSvg, code128 } from '@/modules/shared/barcode'
import type { ZettelDaten } from '@/modules/fertigung/zettel-daten'
import { date, qty } from '@/modules/shared/format'

/**
 * Der Fertigungszettel als Server-Komponente — genutzt vom Einzeldruck
 * (/fertigung/[id]/druck) und vom Sammeldruck (/fertigung/druck?ids=…,
 * Browser-Fallback der Druckbrücke). Aufbau und Daten decken sich mit dem
 * PDF der Druckbrücke (src/modules/fertigung/zettel-pdf.tsx).
 */

/** Beschrifteter Barcode — zwei nackte Code128 sind am Tisch nicht unterscheidbar. */
function CodeBlock({ svg, label }: { svg: string; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        className="barcode"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

export function ZettelAnsicht({ daten }: { daten: ZettelDaten }) {
  const { mo, lieferung, components } = daten
  const fertigungCode = code128(mo.number)
  const versandCode = lieferung ? code128(lieferung) : null
  const artikelCode =
    mo.barcode || mo.sku ? barcodeSvg(mo.barcode ?? mo.sku ?? '', { height: 9, scale: 2 }) : null

  return (
    <div className="print-doc">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
        <div>
          <h1>Fertigungsauftrag {mo.number}</h1>
          <div style={{ fontSize: 13 }}>{daten.firma}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <CodeBlock svg={fertigungCode} label="FERTIGUNG" />
          {versandCode && <CodeBlock svg={versandCode} label="VERSAND" />}
        </div>
      </div>

      <table style={{ marginTop: 16, marginBottom: 20 }}>
        <tbody>
          <tr>
            <th style={{ width: '25%' }}>Produkt</th>
            <td>
              {mo.product}
              {mo.sku && <span style={{ color: '#555' }}> · {mo.sku}</span>}
            </td>
          </tr>
          {artikelCode && (
            <tr>
              <th>Artikel-Code</th>
              <td>
                {/* Wird am Packtisch je gepacktem Stück gescannt — derselbe
                    Code klebt auch auf dem fertigen Artikel. */}
                <span
                  className="barcode"
                  aria-label={`Artikel ${mo.barcode ?? mo.sku}`}
                  dangerouslySetInnerHTML={{ __html: artikelCode }}
                />
              </td>
            </tr>
          )}
          <tr>
            <th>Menge</th>
            <td style={{ fontSize: 16, fontWeight: 700 }}>
              {qty(mo.qty_to_produce)} {mo.uom}
            </td>
          </tr>
          <tr>
            <th>Termin</th>
            <td>{date(mo.scheduled_date as string)}</td>
          </tr>
          {mo.sales_order_number && (
            <tr>
              <th>Verkaufsauftrag</th>
              <td>
                {mo.sales_order_number}
                {mo.shopify_order_name && ` (${mo.shopify_order_name})`}
                {mo.customer && ` · ${mo.customer}`}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ fontSize: 15, marginBottom: 6 }}>Komponenten</h2>
      <table>
        <thead>
          <tr>
            <th style={{ width: 34 }}>✓</th>
            <th>Komponente</th>
            <th>Artikelnr.</th>
            <th style={{ textAlign: 'right', width: 90 }}>Menge</th>
            <th style={{ width: 70 }}>Einheit</th>
          </tr>
        </thead>
        <tbody>
          {components.map((c) => (
            <tr key={c.id}>
              <td style={{ textAlign: 'center' }}>☐</td>
              <td>{c.product}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.sku ?? '—'}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty(c.qty)}</td>
              <td>{c.uom}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {mo.note && (
        <div style={{ marginTop: 20, fontSize: 12 }}>
          <strong>Notizen:</strong> {mo.note}
        </div>
      )}

      <div style={{ marginTop: 32, display: 'flex', gap: 40, fontSize: 12 }}>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Gefertigt von / Datum</div>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Geprüft von / Datum</div>
      </div>
    </div>
  )
}
