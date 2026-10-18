import { requireArea } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, isoDatum, money, plural } from '@/modules/shared/format'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { Seiten } from '@/components/seiten'
import { datevUebergeben } from './actions'

export const dynamic = 'force-dynamic'

const FILTER = {
  alle: 'Alle',
  offen: 'Offen',
  ueberfaellig: 'Überfällig',
  bezahlt: 'Bezahlt',
  gutschriften: 'Gutschriften',
  storniert: 'Storniert',
  probelauf: 'Probelauf',
} as const
type Filter = keyof typeof FILTER

/**
 * Kundenrechnungen (0115): entstehen bei der Lieferung — hier die Liste mit
 * Filter, offenen Beträgen und dem DATEV-Export des Monats. Der Probelauf
 * (0117) hat seinen eigenen Filter: Testbelege (PROBE-…) stehen nur dort,
 * mit dem Vergleich je Bestellung gegen den Gesamtbetrag laut Shop.
 */
export default async function KundenrechnungenPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; seite?: string }>
}) {
  const user = await requireArea('verkauf')
  const darfFinanzen = canAccess(user.rollen, 'finanzen', user.befugnisse)
  const params = await searchParams
  const { filter: roh } = params
  const seite = seitenParameter(params)
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
      probe: boolean
    }[]
  >`
    select count(*) over () as gesamt, k.id, k.nummer, k.art::text as art, k.status::text as status, k.rechnungsdatum::text as rechnungsdatum,
           k.faellig_am::text as faellig_am, coalesce(k.anschrift ->> 'name', p.name) as kunde, k.partner_id,
           k.sales_order_id, so.number as auftrag, k.kundenreferenz, k.zahlungsart, k.brutto,
           kundenrechnung_offen(k.id) as offen, k.mahnstufe,
           (k.status = 'offen' and k.art = 'rechnung' and k.faellig_am < current_date) as ueberfaellig,
           k.datev_uebergeben_am is not null as datev, k.probe
    from kundenrechnungen k
    left join partners p on p.id = k.partner_id
    left join sales_orders so on so.id = k.sales_order_id
    where case ${filter}
            when 'probelauf' then k.probe
            when 'offen' then k.status = 'offen' and not k.probe
            when 'ueberfaellig' then k.status = 'offen' and k.art = 'rechnung' and k.faellig_am < current_date and not k.probe
            when 'bezahlt' then k.status = 'bezahlt' and not k.probe
            when 'gutschriften' then k.art = 'gutschrift' and not k.probe
            when 'storniert' then k.status = 'storniert' and not k.probe
            else not k.probe end
    order by k.rechnungsdatum desc, k.created_at desc
    limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(belege)

  const [summen] = await sql<{ offen: number; ueberfaellig: number; monat: number; anzahl_monat: number }[]>`
    select coalesce(sum(kundenrechnung_offen(id)) filter (where art = 'rechnung' and status = 'offen'), 0) as offen,
           count(*) filter (where art = 'rechnung' and status = 'offen' and faellig_am < current_date)::int as ueberfaellig,
           coalesce(sum(case art when 'rechnung' then brutto else -brutto end)
                    filter (where status <> 'storniert' and date_trunc('month', rechnungsdatum) = date_trunc('month', current_date)), 0) as monat,
           count(*) filter (where date_trunc('month', rechnungsdatum) = date_trunc('month', current_date))::int as anzahl_monat
    from kundenrechnungen
    where not probe`

  // Probelauf (0117): Modus, Anzahl der Testbelege und der Vergleich je Bestellung gegen den Shop.
  const [lage] = await sql<{ modus: string; testbelege: number }[]>`
    select rechnung_modus() as modus, (select count(*)::int from kundenrechnungen where probe) as testbelege`
  const vergleich =
    filter === 'probelauf'
      ? await sql<
          { id: string; bestellung: string; shopify_brutto: number | null; krnl_brutto: number; belege: number; nummern: string; letzte: string }[]
        >`
          select so.id, coalesce(so.shopify_order_name, so.number) as bestellung, so.shopify_brutto,
                 sum(case k.art when 'rechnung' then k.brutto else -k.brutto end) as krnl_brutto,
                 count(*)::int as belege, string_agg(k.nummer, ', ' order by k.created_at) as nummern,
                 max(k.created_at)::text as letzte
          from kundenrechnungen k
          join sales_orders so on so.id = k.sales_order_id
          where k.probe
          group by so.id
          order by max(k.created_at) desc
          limit 300`
      : []
  const abweichung = (z: { shopify_brutto: number | null; krnl_brutto: number }) =>
    z.shopify_brutto === null ? null : Math.round((Number(z.krnl_brutto) - Number(z.shopify_brutto)) * 100) / 100
  const vergleichSumme = {
    gleich: vergleich.filter((z) => abweichung(z) !== null && Math.abs(abweichung(z)!) < 0.005).length,
    abweichend: vergleich.filter((z) => abweichung(z) !== null && Math.abs(abweichung(z)!) >= 0.005).length,
    ohne: vergleich.filter((z) => abweichung(z) === null).length,
  }

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

      {lage.modus !== 'scharf' && (
        <Card tight>
          <p className="small" style={{ margin: 12 }}>
            {lage.modus === 'test' ? (
              <>
                <strong>Probelauf läuft:</strong> Mit jeder gebuchten Lieferung entsteht eine <em>Testrechnung</em> (PROBE-RE-…)
                parallel zur Rechnung aus sevDesk. Testbelege zählen nicht in DATEV, Fälligkeiten und Umsatz; die echten Filter
                hier bleiben leer, bis scharf geschaltet ist. Vergleich und Aufräumen:{' '}
                <Link href="/verkauf/rechnungen?filter=probelauf">Probelauf</Link> · scharf schalten unter{' '}
                <Link href="/einstellungen/belege">Einstellungen → Belege</Link>.
              </>
            ) : (
              <>
                <strong>Automatik aus:</strong> Rechnungen entstehen nur von Hand aus der Lieferung. Modus unter{' '}
                <Link href="/einstellungen/belege">Einstellungen → Belege</Link>.
              </>
            )}
          </p>
        </Card>
      )}

      <div className="tiles" style={{ marginBottom: 12 }}>
        <div className="info-panel">
          <div className="display-head"><span>Offene Forderungen</span></div>
          <div className="mono" style={{ fontSize: 18 }}>{money(summen.offen)}</div>
        </div>
        <div className="info-panel">
          <div className="display-head"><span>Überfällig</span></div>
          <div className="mono" style={{ fontSize: 18, color: Number(summen.ueberfaellig) > 0 ? 'var(--danger)' : undefined }}>
            {summen.ueberfaellig}
          </div>
        </div>
        <div className="info-panel">
          <div className="display-head"><span>Umsatz brutto dieser Monat</span><span>{summen.anzahl_monat} Belege</span></div>
          <div className="mono" style={{ fontSize: 18 }}>{money(summen.monat)}</div>
        </div>
      </div>

      <Card tight>
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {(Object.keys(FILTER) as Filter[]).map((f) => (
            <Link key={f} className="btn small" aria-current={f === filter ? 'page' : undefined} href={`/verkauf/rechnungen?filter=${f}`}>
              {FILTER[f]}
            </Link>
          ))}
        </div>
        {filter === 'probelauf' && (
          <div style={{ padding: '0 12px 12px' }}>
            <p className="small muted" style={{ margin: '0 0 8px' }}>
              Vergleich je Bestellung: Summe der Testbelege (Rechnungen minus Gutschriften) gegen den Gesamtbetrag laut Shop
              (brutto inkl. Versand, nach Änderungen der aktuelle Stand) — die sevDesk-Rechnung dazu stichprobenartig von Hand. Bestellungen von vor dem Probelauf tragen den
              Shop-Betrag erst nach dem nächsten Abgleich.
              {' '}{plural(lage.testbelege, 'Testbeleg', 'Testbelege')} · {vergleichSumme.gleich} gleich · {vergleichSumme.abweichend} abweichend ·{' '}
              {vergleichSumme.ohne} ohne Shop-Betrag.
              {' '}Aufräumen und scharf schalten: <Link href="/einstellungen/belege">Einstellungen → Belege</Link>.
            </p>
            {vergleich.length > 0 && (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Bestellung</th>
                      <th>Testbelege</th>
                      <th className="num">Shop brutto</th>
                      <th className="num">KRNL brutto</th>
                      <th className="num">Abweichung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vergleich.map((z) => {
                      const d = abweichung(z)
                      return (
                        <tr key={z.id}>
                          <td className="mono"><Link href={`/verkauf/${z.id}`}>{z.bestellung}</Link></td>
                          <td className="mono small">{z.nummern}</td>
                          <td className="num nowrap">{z.shopify_brutto === null ? '—' : money(z.shopify_brutto)}</td>
                          <td className="num nowrap">{money(z.krnl_brutto)}</td>
                          <td className="num nowrap">
                            {d === null ? (
                              <span className="muted">kein Shop-Betrag</span>
                            ) : Math.abs(d) < 0.005 ? (
                              <span className="badge success">gleich</span>
                            ) : (
                              <span className="badge warn">{d > 0 ? '+' : ''}{money(d)}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </div>
        )}
        {belege.length === 0 ? (
          <Empty>
            {filter === 'probelauf'
              ? 'Noch kein Testbeleg — der erste entsteht mit der nächsten gebuchten Lieferung.'
              : `Keine Belege${filter !== 'alle' ? ' in dieser Auswahl' : ' — die erste Rechnung entsteht mit der ersten gebuchten Lieferung'}.`}
          </Empty>
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
                        {b.probe && <span className="badge warn" title="Testbeleg des Probelaufs — zählt nirgends">Test</span>}
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
        <Seiten pfad="/verkauf/rechnungen" params={params} seite={seite} gesamt={gesamt} />
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
