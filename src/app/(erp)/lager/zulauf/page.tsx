import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader } from '@/components/ui'
import { date as datum } from '@/modules/shared/format'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

/**
 * Wareneingangskalender (BUG/00004): der Lagerist sieht, was wann ankommt —
 * Wochenansicht über die offenen Eingangs-Transfers. Der Termin kommt aus
 * scheduled_date (von der Bestellung synchronisiert: bestätigte ETA vor
 * Schätzung), Überfälliges steht rot obenan, Sendungen sind verlinkt.
 */

interface Eingang {
  id: string
  number: string
  state: string
  vendor: string | null
  bestellung: string | null
  bestellung_id: string | null
  eta_bestaetigt: string | null
  carrier: string | null
  tracking_number: string | null
  tracking_url: string | null
  termin: string | null
  positionen: number
}

const WOCHENTAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']

const iso = (d: Date) => d.toISOString().slice(0, 10)

function EingangsKarte({ e, heute }: { e: Eingang; heute: string }) {
  const ueberfaellig = e.termin != null && e.termin < heute
  const bestaetigt = e.eta_bestaetigt != null && e.eta_bestaetigt === e.termin
  return (
    <div
      className="display-panel"
      style={{ marginBottom: 6, ...(ueberfaellig ? { borderColor: 'var(--danger)' } : {}) }}
    >
      <div className="small">
        <span className={`led ${ueberfaellig ? 'warn' : bestaetigt ? 'ok' : 'off'}`} />{' '}
        <Link className="mono" href={`/lager/${e.id}`}>{e.number}</Link>
        {e.vendor && <> · {e.vendor}</>}
      </div>
      <div className="small muted">
        {e.bestellung && e.bestellung_id && (
          <>
            <Link className="mono" href={`/einkauf/${e.bestellung_id}`}>{e.bestellung}</Link> ·{' '}
          </>
        )}
        {e.positionen} Position(en)
        {bestaetigt ? ' · bestätigt' : e.termin ? ' · geschätzt' : ''}
      </div>
      {(e.carrier || e.tracking_number) && (
        <div className="small muted">
          {e.carrier}
          {e.tracking_number && (
            <>
              {e.carrier ? ' · ' : ''}
              {e.tracking_url ? (
                <a href={e.tracking_url} target="_blank" rel="noreferrer">
                  <span className="mono">{e.tracking_number}</span>
                </a>
              ) : (
                <span className="mono">{e.tracking_number}</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default async function ZulaufPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>
}) {
  await requireArea('lager')
  const { w } = await searchParams
  const offset = Number.isFinite(Number(w)) ? Number(w) : 0

  const eingaenge = await sql<Eingang[]>`
    select p.id, p.number, p.state,
           part.name as vendor,
           po.number as bestellung, po.id as bestellung_id,
           po.eta_confirmed::text as eta_bestaetigt,
           po.carrier, po.tracking_number, po.tracking_url,
           coalesce(po.eta_confirmed::text, p.scheduled_date::date::text) as termin,
           (select count(*) from stock_moves m
             where m.picking_id = p.id and m.state <> 'cancel')::int as positionen
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'receipt'
    left join partners part on part.id = p.partner_id
    left join purchase_orders po
      on p.origin_model = 'purchase_order' and po.id = p.origin_id
    where p.state not in ('done', 'cancel')
    order by termin nulls last, p.number`

  // Wochenraster: Montag der angezeigten Woche in UTC — dieselbe Basis, auf
  // der auch die Termine (date-Spalten) liegen.
  const jetzt = new Date()
  const heute = iso(jetzt)
  const montag = new Date(jetzt)
  montag.setUTCDate(jetzt.getUTCDate() - ((jetzt.getUTCDay() + 6) % 7) + offset * 7)
  const tage = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(montag)
    d.setUTCDate(montag.getUTCDate() + i)
    return iso(d)
  })

  const ueberfaellige = eingaenge.filter((e) => e.termin != null && e.termin < heute)
  const ohneTermin = eingaenge.filter((e) => e.termin == null)
  const jeTag = new Map<string, Eingang[]>(tage.map((t) => [t, []]))
  for (const e of eingaenge) {
    if (e.termin != null && jeTag.has(e.termin)) jeTag.get(e.termin)!.push(e)
  }

  return (
    <>
      <PageHeader
        title="Zulauf"
        subtitle="Erwartete Wareneingänge — Termine kommen von der Bestellung (bestätigte ETA vor Schätzung)"
        actions={
          <>
            <Link className="btn" href={`/lager/zulauf?w=${offset - 1}`}>← Vorwoche</Link>
            <Link className="btn" href="/lager/zulauf" aria-current={offset === 0 ? 'page' : undefined}>
              Heute
            </Link>
            <Link className="btn" href={`/lager/zulauf?w=${offset + 1}`}>Folgewoche →</Link>
          </>
        }
      />

      {ueberfaellige.length > 0 && (
        <Card title={`Überfällig (${ueberfaellige.length})`}>
          <div className="grid-3">
            {ueberfaellige.map((e) => (
              <div key={e.id}>
                <div className="small muted" style={{ marginBottom: 2 }}>
                  erwartet {datum(e.termin)}
                </div>
                <EingangsKarte e={e} heute={heute} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={`Woche ${datum(tage[0])} – ${datum(tage[6])}`}
        tight
      >
        {eingaenge.length === 0 ? (
          <Empty>Keine offenen Wareneingänge.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, minmax(150px, 1fr))',
                gap: 0,
                minWidth: 1050,
              }}
            >
              {tage.map((t, i) => (
                <div
                  key={t}
                  style={{
                    padding: 10,
                    borderLeft: i > 0 ? '1px solid var(--border)' : undefined,
                    background: t === heute ? 'var(--surface-2)' : undefined,
                    minHeight: 140,
                  }}
                >
                  <div className="mono-label" style={{ marginBottom: 8 }}>
                    {WOCHENTAGE[i]}
                    <br />
                    <span className={t === heute ? '' : 'muted'}>{datum(t)}</span>
                  </div>
                  {jeTag.get(t)!.map((e) => (
                    <EingangsKarte key={e.id} e={e} heute={heute} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {ohneTermin.length > 0 && (
        <Card title={`Ohne Termin (${ohneTermin.length})`}>
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Diese Eingänge haben keinen Liefertermin — an der Bestellung ETA pflegen, dann
            erscheinen sie im Kalender.
          </p>
          <div className="grid-3">
            {ohneTermin.map((e) => (
              <EingangsKarte key={e.id} e={e} heute={heute} />
            ))}
          </div>
        </Card>
      )}
    </>
  )
}
