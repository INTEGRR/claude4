import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { dhlConfigured } from '@/modules/versand/dhl'
import { createReturnLabel } from '../actions'

export const dynamic = 'force-dynamic'

export default async function RetourenPage() {
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

      <Card tight>
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
                      {l.emailed_at ? (
                        <span className="badge success">{dateTime(l.emailed_at)}</span>
                      ) : (
                        <span className="badge warn">in Warteschlange</span>
                      )}
                    </td>
                    <td className="nowrap small">{dateTime(l.created_at)}</td>
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
