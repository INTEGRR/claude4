import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, dateTime } from '@/modules/shared/format'
import { wiedervorlageErledigen } from '../posteingang/actions'

export const dynamic = 'force-dynamic'

const PFAD = '/einkauf/wiedervorlagen'

/** Wohin eine Wiedervorlage führt — je Beleg Link und Bezeichnung. */
const ZIEL: Record<string, { art: string; pfad: (id: string) => string }> = {
  mail_thread: { art: 'Thread', pfad: (id) => `/einkauf/posteingang/${id}` },
  partner: { art: 'Lieferant', pfad: (id) => `/einkauf/lieferanten/${id}` },
  purchase_order: { art: 'Bestellung', pfad: (id) => `/einkauf/${id}` },
  vendor_bill: { art: 'Rechnung', pfad: (id) => `/einkauf/rechnungen/${id}` },
  einkaufsprojekt: { art: 'Projekt', pfad: (id) => `/einkauf/projekte/${id}` },
}

/**
 * Wiedervorlagen des Einkaufs (0093): „Antwort erwartet bis",
 * „Liefertermin prüfen" — von Hand gesetzt an Thread, Lieferant,
 * Bestellung oder Rechnung. Überfälliges oben. Regelbasierte
 * Wiedervorlagen (fehlende PI, ETA überfällig) kommen mit dem Cockpit.
 */
export default async function WiedervorlagenPage({ searchParams }: { searchParams: Promise<{ alle?: string }> }) {
  const user = await requireArea('einkauf')
  const { alle } = await searchParams
  const nurMeine = alle !== '1'

  const [offen, erledigt] = await Promise.all([
    sql<
      {
        id: string
        modell: string
        record_id: string
        faellig_am: string
        grund: string
        zustaendig: string | null
        erstellt_von: string | null
        ueberfaellig: boolean
        heute: boolean
        bezeichnung: string | null
      }[]
    >`
      select w.id, w.modell, w.record_id, w.faellig_am::text as faellig_am, w.grund, u.name as zustaendig,
             w.erstellt_von, w.faellig_am < current_date as ueberfaellig, w.faellig_am = current_date as heute,
             case w.modell
               when 'mail_thread' then (select coalesce(t.betreff, '(ohne Betreff)') || coalesce(' · ' || p.name, '')
                                        from mail_threads t left join partners p on p.id = t.partner_id where t.id = w.record_id)
               when 'partner' then (select name from partners where id = w.record_id)
               when 'purchase_order' then (select po.number || ' · ' || p.name from purchase_orders po
                                           join partners p on p.id = po.vendor_id where po.id = w.record_id)
               when 'vendor_bill' then (select vb.number || ' · ' || p.name from vendor_bills vb
                                        join partners p on p.id = vb.vendor_id where vb.id = w.record_id)
               when 'einkaufsprojekt' then (select ep.nummer || ' · ' || ep.titel from einkaufsprojekte ep
                                            where ep.id = w.record_id)
             end as bezeichnung
      from wiedervorlagen w
      left join users u on u.id = w.zustaendig_id
      where w.erledigt_am is null and (${!nurMeine} or w.zustaendig_id = ${user.id} or w.zustaendig_id is null)
      order by w.faellig_am, w.created_at
      limit 300`,
    sql<{ id: string; grund: string; erledigt_am: string; erledigt_von: string | null }[]>`
      select id, grund, erledigt_am::text as erledigt_am, erledigt_von from wiedervorlagen
      where erledigt_am is not null order by erledigt_am desc limit 20`,
  ])

  return (
    <>
      <PageHeader
        title="Wiedervorlagen"
        subtitle="Was im Einkauf wann wieder auf den Tisch muss"
        actions={
          <Link className="btn" href="/einkauf/posteingang">
            Posteingang
          </Link>
        }
      />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          <Link className="btn small" href={PFAD} aria-current={nurMeine ? 'page' : undefined}>
            <span className={nurMeine ? 'led on' : 'led off'} /> Meine
          </Link>
          <Link className="btn small" href={`${PFAD}?alle=1`} aria-current={!nurMeine ? 'page' : undefined}>
            <span className={!nurMeine ? 'led on' : 'led off'} /> Alle
          </Link>
        </div>
        {offen.length === 0 ? (
          <Empty>Keine offenen Wiedervorlagen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Fällig</th>
                  <th>Grund</th>
                  <th>Beleg</th>
                  <th>Zuständig</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offen.map((w) => {
                  const ziel = ZIEL[w.modell]
                  return (
                    <tr key={w.id}>
                      <td className={`mono small nowrap${w.ueberfaellig ? ' wv-ueberfaellig' : ''}`}>
                        {date(w.faellig_am)}
                        {w.ueberfaellig ? ' · überfällig' : w.heute ? ' · heute' : ''}
                      </td>
                      <td>{w.grund}</td>
                      <td>
                        {ziel ? (
                          <>
                            <span className="mono-label">{ziel.art}</span>{' '}
                            <Link href={ziel.pfad(w.record_id)}>{w.bezeichnung ?? '—'}</Link>
                          </>
                        ) : (
                          w.modell
                        )}
                      </td>
                      <td className="small">{w.zustaendig ?? '—'}</td>
                      <td className="num">
                        <ActionButton className="small" action={wiedervorlageErledigen.bind(null, w.id, PFAD)}>
                          Erledigt
                        </ActionButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {erledigt.length > 0 && (
        <Card title="Zuletzt erledigt" tight>
          <ul className="dok-liste">
            {erledigt.map((w) => (
              <li key={w.id} className="dok-zeile">
                <span>{w.grund}</span>
                <span className="muted small">
                  {dateTime(w.erledigt_am)} · {w.erledigt_von}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
