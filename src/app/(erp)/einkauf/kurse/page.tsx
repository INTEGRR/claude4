import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, isoDatum } from '@/modules/shared/format'
import { setExchangeRate } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Wechselkurse für den Einkauf in Fremdwährung. Beim Bestätigen einer
 * Bestellung wird der dann gültige Kurs eingefroren — spätere Kursänderungen
 * verändern bereits gebuchte Einstände nicht mehr.
 */
export default async function KursePage() {
  await requireArea('einkauf')

  const currencies = await sql<{ code: string; name: string }[]>`
    select code, name from currencies where active and code <> 'EUR' order by code`

  const kurse = await sql<
    { id: string; currency: string; rate: number; valid_from: string; source: string | null }[]
  >`
    select id, currency, rate, valid_from::text, source
    from exchange_rates order by currency, valid_from desc limit 100`

  const aktuell = await sql<{ currency: string; rate: number; offene: number }[]>`
    select c.code as currency, exchange_rate_at(c.code) as rate,
           (select count(*) from purchase_orders po
             where po.currency = c.code and po.state in ('draft', 'sent'))::int as offene
    from currencies c where c.active and c.code <> 'EUR' order by c.code`

  return (
    <>
      <PageHeader
        title="Wechselkurse"
        subtitle="1 Einheit Fremdwährung = x Euro. Beim Bestätigen einer Bestellung wird der Kurs eingefroren."
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        {aktuell.map((a) => (
          <div className="card" key={a.currency} style={{ marginBottom: 0 }}>
            <div className="stat">
              <div className="label">{a.currency} → EUR</div>
              <div className="value mono">{Number(a.rate).toFixed(4)}</div>
              <div className="hint">
                {Number(a.rate) === 1 ? (
                  <>
                    <span className="led warn" /> kein Kurs erfasst
                  </>
                ) : (
                  <>
                    <span className="led ok" /> gepflegt
                  </>
                )}
                {a.offene > 0 && ` · ${a.offene} offene Bestellung(en)`}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Card title="Kurs erfassen">
        <ActionForm action={setExchangeRate}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              <span>Währung</span>
              <select className="mono" name="currency" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kurs (in Euro)</span>
              <input
                className="mono"
                type="number"
                name="rate"
                step="0.00000001"
                min="0.00000001"
                placeholder="z. B. 0.92"
                required
              />
            </label>
            <label className="field">
              <span>Gültig ab</span>
              <input type="date" name="valid_from" defaultValue={isoDatum(new Date())} required />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card title={`Kurshistorie (${kurse.length})`} tight>
        {kurse.length === 0 ? (
          <Empty>Noch keine Kurse erfasst — Einkäufe in Fremdwährung werden 1:1 umgerechnet.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Währung</th>
                  <th className="num">Kurs</th>
                  <th>Gültig ab</th>
                  <th>Quelle</th>
                </tr>
              </thead>
              <tbody>
                {kurse.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">{k.currency}</td>
                    <td className="num mono">{Number(k.rate).toFixed(8).replace(/0+$/, '')}</td>
                    <td className="mono nowrap">{date(k.valid_from)}</td>
                    <td className="small muted">{k.source ?? '—'}</td>
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
