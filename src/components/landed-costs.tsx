import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, TableWrap } from '@/components/ui'
import { cancelLandedCost, createLandedCost, postLandedCost } from '@/app/(erp)/einkauf/actions'
import { dateTime, money } from '@/modules/shared/format'

/**
 * Einstandsnebenkosten zu einem Wareneingang: Fracht, Zoll, Versicherung,
 * Handling. Sie treffen meist Wochen nach der Ware ein — deshalb lassen sie
 * sich als Schätzung buchen und später korrigieren.
 */

const TYPE_LABEL: Record<string, string> = {
  freight: 'Fracht',
  customs_duty: 'Zoll',
  insurance: 'Versicherung',
  handling: 'Handling',
  other: 'Sonstiges',
}
const BASIS_LABEL: Record<string, string> = {
  weight: 'nach Gewicht',
  value: 'nach Wert',
  quantity: 'nach Menge',
}

export async function LandedCosts({ pickingId }: { pickingId: string }) {
  const kosten = await sql<
    {
      id: string
      number: string
      cost_type: string
      basis: string
      amount: number
      currency: string
      exchange_rate: number
      is_estimate: boolean
      state: string
      posted_at: string | null
      vendor: string | null
      verteilt: number
    }[]
  >`
    select lc.id, lc.number, lc.cost_type, lc.basis, lc.amount, lc.currency,
           lc.exchange_rate, lc.is_estimate, lc.state, lc.posted_at, p.name as vendor,
           coalesce((select sum(a.amount) from landed_cost_allocations a
                     where a.landed_cost_id = lc.id), 0) as verteilt
    from landed_costs lc
    left join partners p on p.id = lc.vendor_id
    where lc.picking_id = ${pickingId}
    order by lc.created_at`

  const vendors = await sql<{ id: string; name: string }[]>`
    select id, name from partners where is_vendor and active order by name limit 200`
  const currencies = await sql<{ code: string; name: string }[]>`
    select code, name from currencies where active order by code`

  const gesamt = kosten
    .filter((k) => k.state === 'posted')
    .reduce((sum, k) => sum + Number(k.verteilt), 0)

  return (
    <Card
      title="Einstandsnebenkosten"
      actions={
        gesamt > 0 ? (
          <span className="mono-label">auf den Einstand verteilt: {money(gesamt)}</span>
        ) : (
          <span className="mono-label">Fracht, Zoll, Versicherung</span>
        )
      }
      tight
    >
      {kosten.length === 0 ? (
        <Empty>
          Noch keine Nebenkosten erfasst. Fracht und Zoll gehören zum Einstand und heben den
          Durchschnittspreis der eingegangenen Ware.
        </Empty>
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Beleg</th>
                <th>Art</th>
                <th>Verteilung</th>
                <th className="num">Betrag</th>
                <th>Status</th>
                <th>Lieferant</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {kosten.map((k) => (
                <tr key={k.id}>
                  <td className="mono small">
                    {k.number}
                    {k.is_estimate && (
                      <div className="small muted nowrap">
                        <span className="led warn" /> geschätzt
                      </div>
                    )}
                  </td>
                  <td>{TYPE_LABEL[k.cost_type] ?? k.cost_type}</td>
                  <td className="small muted">{BASIS_LABEL[k.basis] ?? k.basis}</td>
                  <td className="num mono">
                    {money(k.amount, k.currency)}
                    {k.currency !== 'EUR' && (
                      <div className="small muted nowrap">
                        Kurs {Number(k.exchange_rate).toFixed(4)} · {money(Number(k.amount) * Number(k.exchange_rate))}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className={
                          k.state === 'posted' ? 'led ok' : k.state === 'cancel' ? 'led off' : 'led warn'
                        }
                      />
                      {k.state === 'posted' ? 'gebucht' : k.state === 'cancel' ? 'storniert' : 'Entwurf'}
                    </span>
                    {k.posted_at && (
                      <div className="small muted nowrap mono">{dateTime(k.posted_at)}</div>
                    )}
                  </td>
                  <td className="small">{k.vendor ?? '—'}</td>
                  <td className="num">
                    <div className="actions">
                      {k.state === 'draft' && (
                        <ActionButton
                          className="small primary"
                          action={postLandedCost.bind(null, k.id, pickingId)}
                        >
                          Buchen
                        </ActionButton>
                      )}
                      {k.state === 'posted' && (
                        <ActionButton
                          className="small danger"
                          action={cancelLandedCost.bind(null, k.id, pickingId)}
                          confirm="Nebenkosten stornieren? Der verteilte Wert wird zurückgenommen."
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

      <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
        <ActionForm action={createLandedCost.bind(null, pickingId)}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              <span>Kostenart</span>
              <select name="cost_type" defaultValue="freight">
                <option value="freight">Fracht</option>
                <option value="customs_duty">Zoll</option>
                <option value="insurance">Versicherung</option>
                <option value="handling">Handling</option>
                <option value="other">Sonstiges</option>
              </select>
            </label>
            <label className="field">
              <span>Verteilung</span>
              <select name="basis" defaultValue="weight">
                <option value="weight">nach Gewicht</option>
                <option value="value">nach Wert</option>
                <option value="quantity">nach Menge</option>
              </select>
            </label>
            <label className="field">
              <span>Betrag</span>
              <input className="mono" type="number" name="amount" step="0.01" min="0.01" required />
            </label>
            <label className="field">
              <span>Währung</span>
              <select className="mono" name="currency" defaultValue="EUR">
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rechnungssteller</span>
              <select name="vendor_id" defaultValue="">
                <option value="">—</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </label>
            <label className="shrink" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingBottom: 7 }}>
              <input type="checkbox" name="is_estimate" />
              <span className="mono-label">geschätzt</span>
            </label>
            <div className="shrink field">
              <button type="submit">Erfassen</button>
            </div>
          </div>
        </ActionForm>
      </div>
    </Card>
  )
}
