import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader, Stat, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, money } from '@/modules/shared/format'
import { darlehenAuszahlen, darlehenRateZahlen } from '../../actions'

export const dynamic = 'force-dynamic'

/** Darlehensdetail: Konditionen + kompletter Tilgungsplan mit Abhaken. */
export default async function DarlehenDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('finanzen')
  const { id } = await params

  const [d] = await sql<
    { id: string; nummer: string; name: string; partner: string | null; betrag: number;
      zinssatz_pct: number; art: string; status: string; auszahlung_am: string;
      laufzeit_monate: number; tilgungsfrei_monate: number; zahltag: number;
      konto: string | null; notiz: string | null }[]
  >`
    select d.*, p.name as partner, k.name as konto
    from darlehen d
    left join partners p on p.id = d.partner_id
    left join bankkonten k on k.id = d.bankkonto_id
    where d.id = ${id}`
  if (!d) notFound()

  const raten = await sql<
    { id: string; nr: number; faellig_am: string; zins: number; tilgung: number;
      restschuld: number; bezahlt_am: string | null }[]
  >`
    select id, nr, faellig_am, zins, tilgung, restschuld, bezahlt_am
    from darlehen_raten where darlehen_id = ${id} order by nr`

  const offen = raten.filter((r) => !r.bezahlt_am)
  const zinsGesamt = raten.reduce((s, r) => s + Number(r.zins), 0)

  return (
    <>
      <PageHeader
        title={`${d.nummer} — ${d.name}`}
        subtitle={`${money(d.betrag)} · ${Number(d.zinssatz_pct).toFixed(2)} % p. a. · ${d.laufzeit_monate} Monate · ${d.art}`}
        actions={
          d.status === 'geplant' ? (
            <ActionButton
              className="wichtig"
              action={darlehenAuszahlen.bind(null, d.id)}
            >
              Auszahlen
            </ActionButton>
          ) : undefined
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Restschuld"
          value={money(offen.length > 0 ? offen[0].restschuld + Number(offen[0].tilgung) : 0)}
        />
        <Stat label="Offene Raten" value={offen.length} />
        <Stat label="Zinskosten gesamt" value={money(zinsGesamt)} />
      </div>

      <Card title="Tilgungsplan" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Fällig am</th>
                <th style={{ textAlign: 'right' }}>Zins</th>
                <th style={{ textAlign: 'right' }}>Tilgung</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Restschuld</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {raten.map((r) => (
                <tr key={r.id} style={r.bezahlt_am ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.nr}</td>
                  <td className="mono muted">{date(r.faellig_am)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(r.zins)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(r.tilgung)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {money(Number(r.zins) + Number(r.tilgung))}
                  </td>
                  <td className="mono muted" style={{ textAlign: 'right' }}>{money(r.restschuld)}</td>
                  <td>
                    {r.bezahlt_am ? (
                      <><span className="led ok" /> {date(r.bezahlt_am)}</>
                    ) : (
                      <><span className="led off" /> offen</>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!r.bezahlt_am && d.status === 'laufend' && (
                      <ActionButton className="small" action={darlehenRateZahlen.bind(null, r.id)}>
                        Bezahlt
                      </ActionButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card title="Konditionen">
        <TableWrap>
          <table>
            <tbody>
              <tr><td className="mono-label">Geber</td><td>{d.partner ?? '—'}</td></tr>
              <tr><td className="mono-label">Auszahlung</td><td className="mono">{date(d.auszahlung_am)}</td></tr>
              <tr><td className="mono-label">Tilgungsfrei</td><td>{d.tilgungsfrei_monate} Monate</td></tr>
              <tr><td className="mono-label">Zahltag</td><td>{d.zahltag}.</td></tr>
              <tr><td className="mono-label">Bankkonto</td><td>{d.konto ?? '—'}</td></tr>
              {d.notiz && <tr><td className="mono-label">Notiz</td><td>{d.notiz}</td></tr>}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <RecordComments model="darlehen" recordId={id} path={`/finanzen/darlehen/${id}`} />
    </>
  )
}
