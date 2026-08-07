import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { dhlConfigured } from '@/modules/versand/dhl'
import { createReturnLabel } from '../actions'

export const dynamic = 'force-dynamic'

export default async function RetourenPage() {
  await requireArea('versand')
  const labels = await sql<
    {
      id: string
      shipment_number: string
      partner: string
      qr_link: string | null
      emailed_at: string | null
      created_at: string
      repair_number: string | null
    }[]
  >`
    select rl.id, rl.shipment_number, p.name as partner, rl.qr_link, rl.emailed_at,
           rl.created_at, r.number as repair_number
    from return_labels rl
    join partners p on p.id = rl.partner_id
    left join repair_orders r on r.id = rl.repair_order_id
    order by rl.created_at desc limit 50`

  const partners = await sql<{ id: string; name: string; city: string | null }[]>`
    select id, name, city from partners where is_customer and active order by name limit 500`

  return (
    <>
      <PageHeader
        title="Retourenlabels"
        subtitle="DHL-Retourenlabel erzeugen und dem Kunden per E-Mail zusenden"
        actions={
          <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className={dhlConfigured() ? 'led ok' : 'led warn'} />
            <span className="mono-label">
              {dhlConfigured() ? 'DHL verbunden' : 'DHL nicht konfiguriert'}
            </span>
          </span>
        }
      />

      {!dhlConfigured() && (
        <div className="notice warn">
          DHL ist nicht konfiguriert. Für Retourenlabels wird zusätzlich ein Retouren-Vertrag mit einem
          im Geschäftskundenportal angelegten Retourenempfänger benötigt.
        </div>
      )}

      <Card title="Neues Retourenlabel">
        <ActionForm action={createReturnLabel}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Kunde</span>
              <select name="partner_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.city ? ` · ${p.city}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Referenz</span>
              <input name="reference" placeholder="z. B. Auftragsnummer" />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit" disabled={!dhlConfigured()}>
                Label erzeugen
              </button>
            </div>
          </div>
        </ActionForm>
      </Card>

      {/* Der QR-Link des zuletzt erzeugten Labels ist Scanner-Datum — dunkle Datenfläche. */}
      {labels[0]?.qr_link && (
        <div className="display-panel" style={{ marginBottom: 16 }}>
          <div className="display-head">
            <span>Retoure · QR</span>
            <span className="mono">{labels[0].shipment_number}</span>
          </div>
          <a
            className="mono small"
            href={labels[0].qr_link}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--display-bright)', wordBreak: 'break-all' }}
          >
            {labels[0].qr_link}
          </a>
        </div>
      )}

      <Card title={`Erzeugte Retourenlabels (${labels.length})`} tight>
        {labels.length === 0 ? (
          <Empty>Noch keine Retourenlabels.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendungsnummer</th>
                  <th>Kunde</th>
                  <th>Reparatur</th>
                  <th>Versendet</th>
                  <th>Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.shipment_number}</td>
                    <td>{l.partner}</td>
                    <td className="mono small">{l.repair_number ?? '—'}</td>
                    <td>
                      {/* Zustand als Leuchte plus Wort; der Zeitstempel bleibt lesbares Mono. */}
                      {l.emailed_at ? (
                        <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span className="led ok" />
                          <span className="mono small">versendet {dateTime(l.emailed_at)}</span>
                        </span>
                      ) : (
                        <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span className="led warn" />
                          <span className="mono small">in Warteschlange</span>
                        </span>
                      )}
                    </td>
                    <td className="mono nowrap small">{dateTime(l.created_at)}</td>
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
