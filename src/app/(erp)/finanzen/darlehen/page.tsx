import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/** Fremdkapital: Darlehen mit Restschuld und nächster Rate. */
export default async function DarlehenSeite() {
  await requireArea('finanzen')

  const darlehen = await sql<
    { id: string; nummer: string; name: string; partner: string | null; betrag: number;
      zinssatz_pct: number; art: string; status: string; auszahlung_am: string;
      restschuld: number; naechste_rate: string | null; rate_summe: number | null }[]
  >`
    select d.id, d.nummer, d.name, p.name as partner, d.betrag, d.zinssatz_pct,
           d.art, d.status, d.auszahlung_am,
           coalesce((select min(r.restschuld) from darlehen_raten r
                     where r.darlehen_id = d.id and r.bezahlt_am is not null), d.betrag) as restschuld,
           (select min(r.faellig_am) from darlehen_raten r
             where r.darlehen_id = d.id and r.bezahlt_am is null)::text as naechste_rate,
           (select r.zins + r.tilgung from darlehen_raten r
             where r.darlehen_id = d.id and r.bezahlt_am is null
             order by r.nr limit 1) as rate_summe
    from darlehen d
    left join partners p on p.id = d.partner_id
    order by d.status = 'laufend' desc, d.created_at desc`

  const laufend = darlehen.filter((d) => d.status === 'laufend')
  const restGesamt = laufend.reduce((s, d) => s + Number(d.restschuld), 0)

  const ART: Record<string, string> = {
    annuitaet: 'Annuität',
    rate: 'Lineare Rate',
    endfaellig: 'Endfällig',
  }

  return (
    <>
      <PageHeader
        title="Darlehen"
        subtitle="Fremdkapital mit Tilgungsplan — Auszahlung und Raten laufen über das Register"
        actions={
          <Link className="btn small" href="/aktion/finanzen.darlehen_anlegen">
            Darlehen anlegen
          </Link>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Restschuld (laufend)" value={money(restGesamt)} />
        <Stat label="Laufende Darlehen" value={laufend.length} />
        <Stat label="Geplant" value={darlehen.filter((d) => d.status === 'geplant').length} />
      </div>

      <Card title="Darlehensbestand" tight>
        {darlehen.length === 0 ? (
          <Empty>
            Noch kein Darlehen — der Fremdkapitalbedarf aus der Prognose wird hier zur
            konkreten Finanzierung.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Darlehen</th>
                  <th>Geber</th>
                  <th style={{ textAlign: 'right' }}>Summe</th>
                  <th style={{ textAlign: 'right' }}>Restschuld</th>
                  <th>Zins</th>
                  <th>Art</th>
                  <th>Nächste Rate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {darlehen.map((d) => (
                  <tr key={d.id} style={d.status === 'getilgt' ? { opacity: 0.5 } : undefined}>
                    <td>
                      <Link href={`/finanzen/darlehen/${d.id}`}>
                        <span className="mono">{d.nummer}</span> {d.name}
                      </Link>
                    </td>
                    <td className="muted">{d.partner ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(d.betrag)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(d.restschuld)}</td>
                    <td className="mono muted">{Number(d.zinssatz_pct).toFixed(2)} %</td>
                    <td className="muted">{ART[d.art] ?? d.art}</td>
                    <td className="mono muted">
                      {d.naechste_rate
                        ? `${date(d.naechste_rate)} (${money(d.rate_summe ?? 0)})`
                        : '—'}
                    </td>
                    <td>
                      <span className={`led ${d.status === 'laufend' ? 'on' : d.status === 'getilgt' ? 'ok' : 'off'}`} />{' '}
                      {d.status}
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
