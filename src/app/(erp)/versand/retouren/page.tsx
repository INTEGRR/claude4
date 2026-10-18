import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, dateTime } from '@/modules/shared/format'
import { dhlConfigured } from '@/modules/versand/dhl'
import { createReturnLabel } from '../actions'
import { Auswahl } from '@/components/auswahl'
import { kurzKunde } from '@/app/(erp)/kurzanlage'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { Seiten } from '@/components/seiten'

export const dynamic = 'force-dynamic'

const FILTER = {
  offen: 'Offen',
  entscheiden: 'Zu entscheiden',
  pruefen: 'Zu prüfen',
  erstattung: 'Warten auf Erstattung',
  alle: 'Alle',
} as const
type Filter = keyof typeof FILTER

/**
 * Retouren (0119) und Retourenlabels. Oben die Rücksendungen von Shop-Kunden
 * als Prozessbelege, darunter wie bisher das Label ohne Retoure (z. B. für
 * Sonderfälle) und alle erzeugten Labels.
 */
export default async function RetourenPage({ searchParams }: { searchParams: Promise<{ filter?: string; seite?: string }> }) {
  const user = await requireArea('versand')
  const params = await searchParams
  const { filter: roh } = params
  const seite = seitenParameter(params)
  const filter: Filter = roh && roh in FILTER ? (roh as Filter) : 'offen'
  const retouren = await sql<
    {
      id: string
      nummer: string
      status: string
      quelle: string
      kunde: string
      partner_id: string
      sales_order_id: string
      bestellung: string | null
      positionen: string | null
      created_at: string
      label: string | null
    }[]
  >`
    select count(*) over () as gesamt, r.id, r.nummer, r.status::text as status, r.quelle, coalesce(so.ship_name, p.name) as kunde, r.partner_id,
           r.sales_order_id, coalesce(so.shopify_order_name, so.number) as bestellung,
           (select string_agg(rp.menge::float || ' × ' || rp.bezeichnung, ', ' order by rp.sequence)
            from retoure_positionen rp where rp.retoure_id = r.id) as positionen,
           r.created_at::text as created_at,
           (select shipment_number from return_labels where retoure_id = r.id order by created_at desc limit 1) as label
    from retouren r
    join sales_orders so on so.id = r.sales_order_id
    join partners p on p.id = r.partner_id
    where case ${filter}
            when 'offen' then r.status in ('angefragt', 'genehmigt', 'eingegangen', 'geprueft')
            when 'entscheiden' then r.status = 'angefragt'
            when 'pruefen' then r.status = 'eingegangen'
            when 'erstattung' then r.status = 'geprueft'
            else true end
    order by r.created_at desc
    limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(retouren)

  const labels = await sql<
    {
      id: string
      shipment_number: string
      partner: string
      partner_id: string
      qr_link: string | null
      emailed_at: string | null
      created_at: string
      repair_number: string | null
      repair_id: string | null
      retoure_nummer: string | null
      retoure_id: string | null
    }[]
  >`
    select rl.id, rl.shipment_number, p.name as partner, p.id as partner_id, rl.qr_link, rl.emailed_at,
           rl.created_at, r.number as repair_number, r.id as repair_id, rt.nummer as retoure_nummer, rt.id as retoure_id
    from return_labels rl
    join partners p on p.id = rl.partner_id
    left join repair_orders r on r.id = rl.repair_order_id
    left join retouren rt on rt.id = rl.retoure_id
    order by rl.created_at desc limit 50`

  const partners = await sql<{ id: string; name: string; city: string | null }[]>`
    select id, name, city from partners where is_customer and active order by name limit 500`

  return (
    <>
      <PageHeader
        title="Retouren"
        subtitle="Rücksendungen von Shop-Kunden — Anfrage, Genehmigung mit Label, Eingang, Prüfung; erstattet wird im Shop"
        actions={
          <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <Link className="btn primary" href="/versand/retouren/neu">Retoure anlegen</Link>
            <span className={dhlConfigured() ? 'led ok' : 'led warn'} />
            <span className="mono-label">
              {dhlConfigured() ? 'DHL verbunden' : 'DHL nicht konfiguriert'}
            </span>
          </span>
        }
      />

      {!dhlConfigured() && (
        <div className="notice warn">
          DHL ist nicht konfiguriert. Für Retourenlabels wird zusätzlich ein Retouren-Vertrag mit einem
          im Geschäftskundenportal angelegten Retourenempfänger benötigt.
        </div>
      )}

      <Card tight>
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {(Object.keys(FILTER) as Filter[]).map((f) => (
            <Link key={f} className={`btn small${f === filter ? ' primary' : ''}`} href={`/versand/retouren?filter=${f}`}>
              {FILTER[f]}
            </Link>
          ))}
        </div>
        {retouren.length === 0 ? (
          <Empty>Keine Retouren{filter !== 'alle' ? ' in dieser Auswahl' : ''}.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Retoure</th>
                  <th>Kunde</th>
                  <th>Bestellung</th>
                  <th>Positionen</th>
                  <th>Label</th>
                  <th>Angefragt</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {retouren.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <Link href={`/versand/retouren/${r.id}`}>{r.nummer}</Link>
                      {r.quelle === 'shop' && <span className="badge neutral" style={{ marginLeft: 6 }}>Portal</span>}
                    </td>
                    <td><Link href={`/kontakte/${r.partner_id}`}>{r.kunde}</Link></td>
                    <td className="mono small"><Link href={`/verkauf/${r.sales_order_id}`}>{r.bestellung}</Link></td>
                    <td className="small">{r.positionen ?? '—'}</td>
                    <td className="mono small">{r.label ?? '—'}</td>
                    <td className="mono nowrap small">{date(r.created_at)}</td>
                    <td><Badge state={r.status} kind="retoure" href={`/versand/retouren/${r.id}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Seiten pfad="/versand/retouren" params={params} seite={seite} gesamt={gesamt} />
      </Card>

      <Card title="Retourenlabel ohne Retoure">
        <ActionForm action={createReturnLabel}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Kunde</span>
              <Auswahl kurzanlage={kurzKunde(user)} name="partner_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.city ? ` · ${p.city}` : ''}
                  </option>
                ))}
              </Auswahl>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Referenz</span>
              <input name="reference" placeholder="z. B. Auftragsnummer" />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit" disabled={!dhlConfigured()}>
                Label erzeugen
              </button>
            </div>
          </div>
        </ActionForm>
      </Card>

      {/* Der QR-Link des zuletzt erzeugten Labels ist Scanner-Datum — dunkle Datenfläche. */}
      {labels[0]?.qr_link && (
        <div className="info-panel" style={{ marginBottom: 16 }}>
          <div className="display-head">
            <span>Retoure · QR</span>
            <span className="mono">{labels[0].shipment_number}</span>
          </div>
          <a
            className="mono small"
            href={labels[0].qr_link}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--text)', wordBreak: 'break-all' }}
          >
            {labels[0].qr_link}
          </a>
        </div>
      )}

      <Card title={`Erzeugte Retourenlabels (${labels.length})`} tight>
        {labels.length === 0 ? (
          <Empty>Noch keine Retourenlabels.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendungsnummer</th>
                  <th>Kunde</th>
                  <th>Zu</th>
                  <th>Versendet</th>
                  <th>Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.shipment_number}</td>
                    <td><Link href={`/kontakte/${l.partner_id}`}>{l.partner}</Link></td>
                    <td className="mono small">
                      {l.repair_id ? (
                        <Link href={`/reparatur/${l.repair_id}`}>{l.repair_number}</Link>
                      ) : l.retoure_id ? (
                        <Link href={`/versand/retouren/${l.retoure_id}`}>{l.retoure_nummer}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {/* Zustand als Leuchte plus Wort; der Zeitstempel bleibt lesbares Mono. */}
                      {l.emailed_at ? (
                        <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span className="led ok" />
                          <span className="mono small">versendet {dateTime(l.emailed_at)}</span>
                        </span>
                      ) : (
                        <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <span className="led warn" />
                          <span className="mono small">in Warteschlange</span>
                        </span>
                      )}
                    </td>
                    <td className="mono nowrap small">{dateTime(l.created_at)}</td>
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
