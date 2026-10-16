import { requireArea } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, isoDatum, money } from '@/modules/shared/format'
import { datevUebergeben } from './actions'

export const dynamic = 'force-dynamic'

const FILTER = {
  alle: 'Alle',
  offen: 'Offen',
  ueberfaellig: 'Überfällig',
  bezahlt: 'Bezahlt',
  gutschriften: 'Gutschriften',
  storniert: 'Storniert',
} as const
type Filter = keyof typeof FILTER

/**
 * Kundenrechnungen (0115): entstehen bei der Lieferung — hier die Liste mit
 * Filter, offenen Beträgen und dem DATEV-Export des Monats.
 */
export default async function KundenrechnungenPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const user = await requireArea('verkauf')
  const darfFinanzen = canAccess(user.rollen, 'finanzen', user.befugnisse)
  const { filter: roh } = await searchParams
  const filter: Filter = roh && roh in FILTER ? (roh as Filter) : 'alle'

  const belege = await sql<
    {
      id: string
      nummer: string
      art: string
      status: string
      rechnungsdatum: string
      faellig_am: string | null
      kunde: string
      partner_id: string
      sales_order_id: string | null
      auftrag: string | null
      kundenreferenz: string | null
      zahlungsart: string | null
      brutto: number
      offen: number
      mahnstufe: number
      ueberfaellig: boolean
      datev: boolean
    }[]
  >`
    select k.id, k.nummer, k.art::text as art, k.status::text as status, k.rechnungsdatum::text as rechnungsdatum,
           k.faellig_am::text as faellig_am, coalesce(k.anschrift ->> 'name', p.name) as kunde, k.partner_id,
           k.sales_order_id, so.number as auftrag, k.kundenreferenz, k.zahlungsart, k.brutto,
           kundenrechnung_offen(k.id) as offen, k.mahnstufe,
           (k.status = 'offen' and k.art = 'rechnung' and k.faellig_am < current_date) as ueberfaellig,
           k.datev_uebergeben_am is not null as datev
    from kundenrechnungen k
    left join partners p on p.id = k.partner_id
    left join sales_orders so on so.id = k.sales_order_id
    where case ${filter}
            when 'offen' then k.status = 'offen'
            when 'ueberfaellig' then k.status = 'offen' and k.art = 'rechnung' and k.faellig_am < current_date
            when 'bezahlt' then k.status = 'bezahlt'
            when 'gutschriften' then k.art = 'gutschrift'
            when 'storniert' then k.status = 'storniert'
            else true end
    order by k.rechnungsdatum desc, k.created_at desc
    limit 300`

  const [summen] = await sql<{ offen: number; ueberfaellig: number; monat: number; anzahl_monat: number }[]>`
    select coalesce(sum(kundenrechnung_offen(id)) filter (where art = 'rechnung' and status = 'offen'), 0) as offen,
           count(*) filter (where art = 'rechnung' and status = 'offen' and faellig_am < current_date)::int as ueberfaellig,
           coalesce(sum(case art when 'rechnung' then brutto else -brutto end)
                    filter (where status <> 'storniert' and date_trunc('month', rechnungsdatum) = date_trunc('month', current_date)), 0) as monat,
           count(*) filter (where date_trunc('month', rechnungsdatum) = date_trunc('month', current_date))::int as anzahl_monat
    from kundenrechnungen`

  const heute = new Date()
  const monatsanfang = isoDatum(new Date(heute.getFullYear(), heute.getMonth(), 1))
  const monatsende = isoDatum(new Date(heute.getFullYear(), heute.getMonth() + 1, 0))

  return (
    <>
      <PageHeader
        title="Kundenrechnungen"
        subtitle="Rechnungen entstehen mit der Lieferung — Shop-Aufträge sind bezahlt, Firmenkunden zahlen auf Rechnung"
        actions={<Link className="btn" href="/verkauf">Verkaufsaufträge</Link>}
      />

      <div className="tiles" style={{ marginBottom: 12 }}>
        <div className="display-panel">
          <div className="display-head"><span>Offene Forderungen</span></div>
          <div className="mono" style={{ fontSize: 18 }}>{money(summen.offen)}</div>
        </div>
        <div className="display-panel">
          <div className="display-head"><span>Überfällig</span></div>
          <div className="mono" style={{ fontSize: 18, color: Number(summen.ueberfaellig) > 0 ? 'var(--danger)' : undefined }}>
            {summen.ueberfaellig}
          </div>
        </div>
        <div className="display-panel">
          <div className="display-head"><span>Umsatz brutto dieser Monat</span><span>{summen.anzahl_monat} Belege</span></div>
          <div className="mono" style={{ fontSize: 18 }}>{money(summen.monat)}</div>
        </div>
      </div>

      <Card tight>
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {(Object.keys(FILTER) as Filter[]).map((f) => (
            <Link key={f} className={`btn small${f === filter ? ' primary' : ''}`} href={`/verkauf/rechnungen?filter=${f}`}>
              {FILTER[f]}
            </Link>
          ))}
        </div>
        {belege.length === 0 ? (
          <Empty>Keine Belege{filter !== 'alle' ? ' in dieser Auswahl' : ' — die erste Rechnung entsteht mit der ersten gebuchten Lieferung'}.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Kunde</th>
                  <th>Auftrag</th>
                  <th>Datum</th>
                  <th>Fällig</th>
                  <th>Zahlungsart</th>
                  <th>Status</th>
                  <th className="num">Betrag</th>
                  <th className="num">Offen</th>
                </tr>
              </thead>
              <tbody>
                {belege.map((b) => (
                  <tr key={b.id} style={b.ueberfaellig ? { background: 'color-mix(in srgb, var(--danger) 8%, transparent)' } : undefined}>
                    <td className="mono">
                      <span className="actions" style={{ gap: 6 }}>
                        <Link href={`/verkauf/rechnungen/${b.id}`}>{b.nummer}</Link>
                        {b.art === 'gutschrift' && <span className="badge info">Gutschrift</span>}
                        {b.mahnstufe > 0 && <span className="badge warn">Mahnstufe {b.mahnstufe}</span>}
                        {b.datev && <span className="badge neutral" title="an DATEV übergeben">DATEV</span>}
                      </span>
                    </td>
                    <td><Link href={`/kontakte/${b.partner_id}`}>{b.kunde}</Link></td>
                    <td className="mono small">
                      {b.sales_order_id ? <Link href={`/verkauf/${b.sales_order_id}`}>{b.kundenreferenz ?? b.auftrag}</Link> : '—'}
                    </td>
                    <td className="mono nowrap">{date(b.rechnungsdatum)}</td>
                    <td className="mono nowrap">{b.art === 'rechnung' && b.status === 'offen' ? date(b.faellig_am) : '—'}</td>
                    <td className="muted">{b.zahlungsart ?? '—'}</td>
                    <td><Badge state={b.status} kind="kundenrechnung" href={`/verkauf/rechnungen/${b.id}`} /></td>
                    <td className="num nowrap">{b.art === 'gutschrift' ? `− ${money(b.brutto)}` : money(b.brutto)}</td>
                    <td className="num nowrap">{Number(b.offen) > 0 ? money(b.offen) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darfFinanzen && (
        <Card title="DATEV-Buchungsstapel">
          <p className="small muted" style={{ marginTop: 0 }}>
            Export der Kundenbelege eines Zeitraums als DATEV-Buchungsstapel (EXTF, Debitor gegen Erlöskonto je
            Steuersatz, Konten unter Einstellungen → Belege). Nach dem Import in DATEV den Zeitraum als übergeben markieren.
          </p>
          <ActionForm action={datevUebergeben}>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field shrink">
                <span>Von</span>
                <input type="date" name="von" defaultValue={monatsanfang} required />
              </label>
              <label className="field shrink">
                <span>Bis</span>
                <input type="date" name="bis" defaultValue={monatsende} required />
              </label>
              <div className="shrink field">
                <a className="btn" href={`/api/verkauf/datev?von=${monatsanfang}&bis=${monatsende}`}>
                  Stapel dieses Monats herunterladen
                </a>
              </div>
              <div className="shrink field">
                <button type="submit">Zeitraum als übergeben markieren</button>
              </div>
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
