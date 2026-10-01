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
  bemusterung: { art: 'Muster', pfad: (id) => `/einkauf/muster/${id}` },
  werkzeug: { art: 'Werkzeug', pfad: (id) => `/einkauf/werkzeuge/${id}` },
  lieferantenvertrag: { art: 'Vertrag', pfad: (id) => `/einkauf/vertraege/${id}` },
}

/**
 * Wiedervorlagen des Einkaufs (0093): „Antwort erwartet bis",
 * „Liefertermin prüfen" — von Hand gesetzt an Thread, Lieferant,
 * Bestellung, Rechnung, Projekt, Muster, Werkzeug oder Vertrag.
 * Überfälliges oben. Darunter die regelbasierten (0107, Sicht
 * einkauf_regel_wiedervorlagen): ablaufende Verträge, Werkzeuge am Ende der
 * Lebensdauer; fehlende PI und überfällige ETA kommen mit dem Cockpit.
 */
export default async function WiedervorlagenPage({ searchParams }: { searchParams: Promise<{ alle?: string }> }) {
  const user = await requireArea('einkauf')
  const { alle } = await searchParams
  const nurMeine = alle !== '1'

  const [offen, erledigt, regeln] = await Promise.all([
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
               when 'bemusterung' then (select ep.nummer || ' · Runde ' || b.runde || ' · ' || p.name
                                        from bemusterungen b join einkaufsprojekte ep on ep.id = b.projekt_id
                                        join partners p on p.id = b.partner_id where b.id = w.record_id)
               when 'werkzeug' then (select wz.nummer || ' · ' || wz.bezeichnung from werkzeuge wz where wz.id = w.record_id)
               when 'lieferantenvertrag' then (select v.titel || ' · ' || p.name from lieferantenvertraege v
                                               join partners p on p.id = v.partner_id where v.id = w.record_id)
             end as bezeichnung
      from wiedervorlagen w
      left join users u on u.id = w.zustaendig_id
      where w.erledigt_am is null and (${!nurMeine} or w.zustaendig_id = ${user.id} or w.zustaendig_id is null)
      order by w.faellig_am, w.created_at
      limit 300`,
    sql<{ id: string; grund: string; erledigt_am: string; erledigt_von: string | null }[]>`
      select id, grund, erledigt_am::text as erledigt_am, erledigt_von from wiedervorlagen
      where erledigt_am is not null order by erledigt_am desc limit 20`,
    // Regelbasiert (0107): ablaufende Verträge, Werkzeuge am Ende der Lebensdauer — berechnet.
    sql<
      {
        modell: string
        record_id: string
        grund: string
        faellig_am: string
        frist: string | null
        ueberfaellig: boolean
        partner_id: string
        lieferant: string
        zustaendig: string | null
      }[]
    >`
      select r.modell, r.record_id, r.grund, r.faellig_am::text as faellig_am, r.frist::text as frist,
             coalesce(r.frist, r.faellig_am) < current_date as ueberfaellig,
             r.partner_id, p.name as lieferant, u.name as zustaendig
      from einkauf_regel_wiedervorlagen r
      join partners p on p.id = r.partner_id
      left join users u on u.id = r.zustaendig_id
      where (${!nurMeine} or r.zustaendig_id = ${user.id} or r.zustaendig_id is null)
      order by coalesce(r.frist, r.faellig_am), r.grund`,
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

      {regeln.length > 0 && (
        <Card title={`Von selbst (${regeln.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Frist</th>
                  <th>Grund</th>
                  <th>Lieferant</th>
                  <th>Zuständig</th>
                </tr>
              </thead>
              <tbody>
                {regeln.map((r) => {
                  const ziel = ZIEL[r.modell]
                  return (
                    <tr key={`${r.modell}:${r.record_id}`}>
                      <td className={`mono small nowrap${r.ueberfaellig ? ' wv-ueberfaellig' : ''}`}>
                        {date(r.frist ?? r.faellig_am)}
                        {r.ueberfaellig ? ' · überfällig' : ''}
                      </td>
                      <td>
                        {ziel ? (
                          <>
                            <span className="mono-label">{ziel.art}</span>{' '}
                            <Link href={ziel.pfad(r.record_id)}>{r.grund}</Link>
                          </>
                        ) : (
                          r.grund
                        )}
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/lieferanten/${r.partner_id}`}>{r.lieferant}</Link>
                      </td>
                      <td className="small">{r.zustaendig ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
            Regelbasiert: ablaufende Lieferantenverträge (ab Kündigungsstichtag minus Erinnerung) und Werkzeuge ab 90 % der
            Lebensdauer. Sie verschwinden von selbst, sobald der Vertrag verlängert, gekündigt oder beendet bzw. das
            Werkzeug ersetzt ist.
          </p>
        </Card>
      )}

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
