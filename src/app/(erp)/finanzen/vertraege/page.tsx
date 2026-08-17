import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

const INTERVALL_MONATE: Record<string, number> = { monatlich: 1, quartalsweise: 3, jaehrlich: 12 }

/**
 * Fixkosten-Verträge: was regelmäßig abfließt, auf einen Blick — mit
 * normalisiertem Monatsbetrag und dem Kündigungssignal (Frist läuft ab =
 * violett, eine Entscheidung).
 */
export default async function VertraegeSeite() {
  await requireArea('finanzen')

  const vertraege = await sql<
    { id: string; nummer: string; name: string; kategorie: string; partner: string | null;
      betrag: number; waehrung: string; intervall: string; status: string;
      beginn: string; ende_effektiv: string | null;
      kuendbar_zum: string | null; frist_bis: string | null; ansteht: boolean;
      naechste_zahlung: string | null; betrag_eur: number }[]
  >`
    select v.id, v.nummer, v.name, v.kategorie, p.name as partner,
           v.betrag, v.waehrung, v.intervall, v.status, v.beginn,
           vertrag_ende_effektiv(v)::text as ende_effektiv,
           vertrag_naechstes_kuendbar_zum(v)::text as kuendbar_zum,
           vertrag_kuendigungsfrist_bis(v)::text as frist_bis,
           vertrag_kuendigung_ansteht(v.id) as ansteht,
           (select min(z.faellig_am) from vertrag_zahlungen_bis(v.id, current_date + 400) z)::text
             as naechste_zahlung,
           round(v.betrag * exchange_rate_at(v.waehrung), 2) as betrag_eur
    from vertraege v
    left join partners p on p.id = v.partner_id
    order by v.status = 'aktiv' desc, v.name`

  const aktive = vertraege.filter((v) => v.status !== 'beendet')
  const monatlich = aktive.reduce(
    (s, v) => s + Number(v.betrag_eur) / (INTERVALL_MONATE[v.intervall] ?? 1),
    0,
  )
  const anstehend = vertraege.filter((v) => v.ansteht)

  return (
    <>
      <PageHeader
        title="Verträge"
        subtitle="Fixkosten: Miete, Lizenzen, Personal-Posten — mit Kündigungsfristen"
        actions={
          <Link className="btn small" href="/aktion/finanzen.vertrag_anlegen">
            Vertrag anlegen
          </Link>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Fixkosten je Monat (normalisiert)" value={money(monatlich)} />
        <Stat label="Laufende Verträge" value={aktive.length} />
        <Stat
          label="Kündigungsfrist läuft ab"
          value={anstehend.length}
          hint={anstehend.length > 0 ? 'Entscheidung nötig' : 'nichts offen'}
        />
      </div>

      <Card title="Vertragsbestand" tight>
        {vertraege.length === 0 ? (
          <Empty>Noch keine Verträge — Miete, Lizenzen (Sendcloud, Replo …) und Personal-Posten hier erfassen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Vertrag</th>
                  <th>Kategorie</th>
                  <th>Partner</th>
                  <th style={{ textAlign: 'right' }}>Betrag</th>
                  <th>Intervall</th>
                  <th>Nächste Zahlung</th>
                  <th>Kündbar zum</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {vertraege.map((v) => (
                  <tr key={v.id} style={v.status === 'beendet' ? { opacity: 0.5 } : undefined}>
                    <td>
                      <Link href={`/finanzen/vertraege/${v.id}`}>
                        <span className="mono">{v.nummer}</span> {v.name}
                      </Link>
                    </td>
                    <td className="muted">{v.kategorie}</td>
                    <td className="muted">{v.partner ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {money(v.betrag, v.waehrung)}
                    </td>
                    <td className="muted">{v.intervall}</td>
                    <td className="mono muted">
                      {v.naechste_zahlung ? date(v.naechste_zahlung) : '—'}
                    </td>
                    <td>
                      {v.status === 'aktiv' && v.kuendbar_zum ? (
                        <span className={v.ansteht ? '' : 'muted'}>
                          {v.ansteht && <span className="led wichtig" style={{ marginRight: 6 }} />}
                          <span className="mono">{date(v.kuendbar_zum)}</span>
                          {v.frist_bis && (
                            <span className="small muted"> · Frist bis {date(v.frist_bis)}</span>
                          )}
                        </span>
                      ) : v.status === 'gekuendigt' && v.ende_effektiv ? (
                        <span className="muted">gekündigt zum {date(v.ende_effektiv)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`led ${v.status === 'aktiv' ? 'ok' : v.status === 'gekuendigt' ? 'warn' : 'off'}`} />{' '}
                      {v.status}
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
