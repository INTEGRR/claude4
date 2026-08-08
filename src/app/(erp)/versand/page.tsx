import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { dhlConfigured } from '@/modules/versand/dhl'
import { cancelLabel, createLabel, refreshTracking } from './actions'

export const dynamic = 'force-dynamic'

const PRODUCTS = [
  { code: 'V01PAK', label: 'DHL Paket (national)' },
  { code: 'V54EPAK', label: 'DHL Europaket' },
  { code: 'V53WPAK', label: 'DHL Paket International' },
]

export default async function VersandPage() {
  await requireArea('versand')
  const ready = await sql<
    {
      picking_id: string
      picking_number: string
      sales_order_id: string | null
      sales_order_number: string | null
      shopify_order_name: string | null
      customer_name: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
      weight_g: number
      shipment_count: number
    }[]
  >`select * from shipping_ready order by scheduled_date limit 100`

  const shipments = await sql<
    {
      id: string
      shipment_number: string
      state: string
      tracking_url: string
      hat_label: boolean
      dhl_product: string
      created_at: string
      picking_number: string
      picking_id: string
      customer: string | null
      shopify_fulfillment_id: string | null
      last_event: { description?: string } | null
    }[]
  >`
    select s.id, s.shipment_number, s.state, s.tracking_url, s.dhl_product,
           (s.label_pdf is not null or s.label_path is not null) as hat_label,
           s.created_at, p.number as picking_number, p.id as picking_id,
           part.name as customer, s.shopify_fulfillment_id,
           s.last_tracking_event as last_event
    from shipments s
    join stock_pickings p on p.id = s.picking_id
    left join partners part on part.id = p.partner_id
    order by s.created_at desc
    limit 60`

  const configured = dhlConfigured()

  return (
    <>
      <PageHeader
        title="Versand"
        subtitle="Fertige Aufträge etikettieren, Sendungen verfolgen"
        actions={
          <>
            {/* Verbindungszustand des Geräts: Leuchte plus Wort, in beiden Richtungen sichtbar. */}
            <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span className={configured ? 'led ok' : 'led warn'} />
              <span className="mono-label">
                {configured ? 'DHL verbunden' : 'DHL nicht konfiguriert'}
              </span>
            </span>
            <Link className="btn" href="/versand/retouren">Retourenlabels</Link>
            <ActionButton action={refreshTracking}>Tracking aktualisieren</ActionButton>
          </>
        }
      />

      {!configured && (
        <div className="notice warn">
          DHL ist noch nicht konfiguriert. Hinterlege API-Key, GKP-Zugangsdaten und Abrechnungsnummer
          als Umgebungsvariablen (siehe <code className="mono">.env.example</code>), dann lassen sich hier Labels erzeugen.
        </div>
      )}

      <Card title={`Versandbereit (${ready.length})`} tight>
        {ready.length === 0 ? (
          <Empty>
            Nichts versandbereit. Lieferungen erscheinen hier, sobald sie reserviert sind und keine
            Fertigungsaufträge mehr offen sind.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Lieferung</th>
                  <th>Auftrag</th>
                  <th>Kunde</th>
                  <th>Ziel</th>
                  <th className="num">Gewicht</th>
                  <th style={{ width: 360 }}>Label</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((r) => (
                  <tr key={r.picking_id}>
                    <td className="mono">
                      <Link href={`/lager/${r.picking_id}`}>{r.picking_number}</Link>
                    </td>
                    <td className="mono small">
                      {r.sales_order_id ? (
                        <Link href={`/verkauf/${r.sales_order_id}`}>
                          {r.shopify_order_name ?? r.sales_order_number}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{r.customer_name ?? '—'}</td>
                    <td className="small">
                      {/* PLZ und Ländercode sind Codes, der Ort bleibt Fließtext. */}
                      <span className="mono">{r.ship_zip}</span> {r.ship_city}{' '}
                      <span className="mono">{r.ship_country_code}</span>
                    </td>
                    <td className="num nowrap">{qty(Number(r.weight_g) / 1000)} kg</td>
                    <td>
                      {Number(r.shipment_count) > 0 ? (
                        <span className="badge success">Label vorhanden</span>
                      ) : (
                        <ActionForm action={createLabel.bind(null, r.picking_id)}>
                          <div className="row" style={{ gap: 6 }}>
                            {/* Einheit sichtbar machen statt nur im title-Attribut. */}
                            <div
                              className="shrink"
                              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <input
                                type="number"
                                name="weight_g"
                                aria-label="Gewicht in Gramm"
                                defaultValue={Math.max(Number(r.weight_g), 1)}
                                min={1}
                                style={{ width: 84 }}
                              />
                              <span className="mono-label">g</span>
                            </div>
                            <div className="shrink">
                              <select
                                name="dhl_product"
                                className="mono"
                                aria-label="DHL-Produkt"
                                defaultValue=""
                                style={{ width: 132 }}
                              >
                                <option value="">automatisch</option>
                                {PRODUCTS.map((p) => (
                                  <option key={p.code} value={p.code}>{p.code} — {p.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="shrink">
                              {/* Zeilenaktion bleibt neutral — Orange ist der Kopfzeile vorbehalten. */}
                              <button className="small" type="submit" disabled={!configured}>
                                Label erstellen
                              </button>
                            </div>
                          </div>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Sendungen" tight>
        {shipments.length === 0 ? (
          <Empty>Noch keine Sendungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendungsnummer</th>
                  <th>Lieferung</th>
                  <th>Kunde</th>
                  <th>Status</th>
                  <th>Shopify</th>
                  <th>Erstellt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <a href={s.tracking_url} target="_blank" rel="noreferrer">{s.shipment_number}</a>
                      {s.last_event?.description && (
                        <div className="muted small">{s.last_event.description}</div>
                      )}
                    </td>
                    <td className="mono small">
                      <Link href={`/lager/${s.picking_id}`}>{s.picking_number}</Link>
                    </td>
                    <td>{s.customer ?? '—'}</td>
                    <td><Badge state={s.state} kind="shipment" /></td>
                    <td>
                      {/* Beide Zustände sind beschriftet — „nicht gemeldet" ist auch ein Zustand. */}
                      <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span className={s.shopify_fulfillment_id ? 'led ok' : 'led off'} />
                        <span className="mono small">
                          {s.shopify_fulfillment_id ? 'gemeldet' : 'offen'}
                        </span>
                      </span>
                    </td>
                    <td className="mono nowrap small">{dateTime(s.created_at)}</td>
                    <td className="num">
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        {s.hat_label && (
                          <a className="btn small" href={`/api/label/${s.id}`} target="_blank">
                            Label
                          </a>
                        )}
                        {s.state === 'created' && (
                          <ActionButton
                            className="small danger"
                            action={cancelLabel.bind(null, s.id)}
                            confirm="Sendung bei DHL stornieren? Das geht nur vor dem Tagesabschluss."
                          >
                            Stornieren
                          </ActionButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
