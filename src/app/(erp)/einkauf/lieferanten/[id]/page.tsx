import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { DokumenteKarte, groesseText } from '@/components/dokumente'
import { MailThreadsKarte, WiedervorlagenKarte } from '@/components/mail-threads'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { DOKUMENT_ARTEN } from '@/modules/einkauf/dokument-modelle'
import { driveLink } from '@/modules/google/drive'
import { date, money, qty } from '@/modules/shared/format'
import { lieferantendatenSetzen } from '../../dokumente-actions'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Lieferantenakte (Einkauf, 0092): alles zu einem Lieferanten auf einer
 * Seite — Einkaufsdaten (Sprache, Maildomains, Einkäufer, Standards),
 * Dateien (eigene und die seiner Bestellungen/Rechnungen), Bestellungen,
 * offene Rechnungen, Lieferantenpreise, Verlauf; seit Stufe 2a (0093) auch
 * die Mail-Threads und Wiedervorlagen.
 */
export default async function LieferantenaktePage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const [p] = await sql<
    {
      id: string
      name: string
      email: string | null
      phone: string | null
      website: string | null
      city: string | null
      country_code: string | null
      is_vendor: boolean
      sprache: string | null
      mail_domains: string[]
      einkaeufer_id: string | null
      standard_incoterm: string | null
      standard_waehrung: string | null
    }[]
  >`
    select id, name, email, phone, website, city, country_code, is_vendor, sprache, mail_domains,
           einkaeufer_id, standard_incoterm, standard_waehrung
    from partners where id = ${id}`
  if (!p) notFound()

  const [einkaeufer, incoterms, waehrungen, bestellungen, rechnungen, preise, fremdeDateien] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
    sql<{ code: string; name: string }[]>`select code, name from incoterms order by code`,
    sql<{ code: string }[]>`select code from currencies order by code`,
    sql<
      {
        id: string
        number: string
        state: string
        created_at: string
        gross: number
        currency: string
        eta: string | null
        tracking_number: string | null
      }[]
    >`
      select po.id, po.number, po.state, po.created_at::text as created_at, t.gross, po.currency,
             coalesce(po.eta_confirmed, po.expected_arrival)::text as eta, po.tracking_number
      from purchase_orders po cross join lateral purchase_order_total(po.id) t
      where po.vendor_id = ${id}
      order by po.created_at desc limit 30`,
    sql<{ id: string; number: string; state: string; due_date: string | null; vendor_bill_reference: string | null }[]>`
      select id, number, state, due_date::text as due_date, vendor_bill_reference
      from vendor_bills where vendor_id = ${id} and state in ('draft', 'posted')
      order by due_date nulls last limit 30`,
    sql<
      {
        id: string
        artikel: string
        min_qty: number
        price: number
        currency: string
        lead_time_days: number | null
        vendor_product_code: string | null
      }[]
    >`
      select vp.id, pt.name as artikel, vp.min_qty::float as min_qty, vp.price::float as price, vp.currency,
             vp.lead_time_days, vp.vendor_product_code
      from vendor_prices vp join product_templates pt on pt.id = vp.template_id
      where vp.vendor_id = ${id}
      order by pt.name, vp.min_qty limit 100`,
    // Dateien an Bestellungen/Rechnungen dieses Lieferanten (die eigenen zeigt die Karte darunter).
    sql<{ id: string; drive_file_id: string; name: string; art: keyof typeof DOKUMENT_ARTEN; groesse: number | null; belege: string | null }[]>`
      select d.id, d.drive_file_id, d.name, d.art::text as art, d.groesse::float as groesse,
             string_agg(coalesce(po.number, vb.number), ', ') as belege
      from dokumente d
      join dokument_verweise v on v.dokument_id = d.id and v.modell <> 'partner'
      left join purchase_orders po on v.modell = 'purchase_order' and po.id = v.record_id
      left join vendor_bills vb on v.modell = 'vendor_bill' and vb.id = v.record_id
      where d.partner_id = ${id}
      group by d.id
      order by d.created_at desc limit 50`,
  ])

  return (
    <>
      <PageHeader
        kicker="Lieferant"
        title={p.name}
        subtitle={[p.city, p.country_code, p.email, p.phone].filter(Boolean).join(' · ')}
        actions={
          <Link className="btn" href={`/kontakte/${id}`}>
            Kontakt
          </Link>
        }
      />

      <Card title="Einkaufsdaten">
        <ActionForm action={lieferantendatenSetzen.bind(null, id)}>
          <div className="row">
            <label className="field">
              <span>Sprache</span>
              <select name="sprache" defaultValue={p.sprache ?? ''}>
                <option value="">—</option>
                <option value="de">Deutsch</option>
                <option value="en">Englisch</option>
                <option value="zh">Chinesisch</option>
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Maildomains / Adressen (Komma-getrennt)</span>
              <input
                name="mail_domains"
                className="mono"
                defaultValue={p.mail_domains.join(', ')}
                placeholder="example-pcb.com, sales88@qq.com"
              />
            </label>
            <label className="field">
              <span>Einkäufer</span>
              <select name="einkaeufer_id" defaultValue={p.einkaeufer_id ?? ''}>
                <option value="">—</option>
                {einkaeufer.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field shrink">
              <span>Incoterm</span>
              <select name="standard_incoterm" defaultValue={p.standard_incoterm ?? ''}>
                <option value="">—</option>
                {incoterms.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="field shrink">
              <span>Währung</span>
              <select name="standard_waehrung" defaultValue={p.standard_waehrung ?? ''}>
                <option value="">—</option>
                {waehrungen.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code}
                  </option>
                ))}
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">
                Speichern
              </button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Über die Maildomains ordnet KRNL eingehende Mails dem Lieferanten zu — bei Freemailern
          (qq.com, 163.com, gmail.com …) die volle Adresse eintragen. Vorlagen und Entwürfe entstehen in
          seiner Sprache.
          {!p.is_vendor && ' Mit dem Speichern wird der Kontakt zum Lieferanten.'}
        </p>
      </Card>

      <MailThreadsKarte partnerId={id} />
      <WiedervorlagenKarte modell="partner" recordId={id} pfad={`/einkauf/lieferanten/${id}`} />
      <DokumenteKarte modell="partner" recordId={id} titel="Dateien des Lieferanten" />

      {fremdeDateien.length > 0 && (
        <Card title={`Dateien an Bestellungen und Rechnungen (${fremdeDateien.length})`} tight>
          <ul className="dok-liste">
            {fremdeDateien.map((d) => (
              <li key={d.id} className="dok-zeile">
                <div className="dok-text">
                  <a href={driveLink(d.drive_file_id)} target="_blank" rel="noopener" className="dok-name">
                    {d.name}
                  </a>
                  <div className="muted small">
                    <span className="mono-label">{DOKUMENT_ARTEN[d.art] ?? d.art}</span> · {groesseText(d.groesse)}
                    {d.belege ? <> · {d.belege}</> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Bestellungen (${bestellungen.length})`} tight>
        {bestellungen.length === 0 ? (
          <Empty>Noch keine Bestellungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Status</th>
                  <th>Angelegt</th>
                  <th>ETA</th>
                  <th>Tracking</th>
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                {bestellungen.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">
                      <Link href={`/einkauf/${b.id}`}>{b.number}</Link>
                    </td>
                    <td>
                      <Badge state={b.state} kind="purchase" />
                    </td>
                    <td className="mono small">{date(b.created_at)}</td>
                    <td className="mono small">{date(b.eta)}</td>
                    <td className="mono small">{b.tracking_number ?? '—'}</td>
                    <td className="num">{money(b.gross, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {rechnungen.length > 0 && (
        <Card title={`Offene Rechnungen (${rechnungen.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Status</th>
                  <th>Referenz</th>
                  <th>Fällig</th>
                </tr>
              </thead>
              <tbody>
                {rechnungen.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <Link href={`/einkauf/rechnungen/${r.id}`}>{r.number}</Link>
                    </td>
                    <td>
                      <Badge state={r.state} kind="bill" />
                    </td>
                    <td className="mono small">{r.vendor_bill_reference ?? '—'}</td>
                    <td className="mono small">{date(r.due_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title={`Lieferantenpreise (${preise.length})`} tight>
        {preise.length === 0 ? (
          <Empty>Keine Lieferantenpreise hinterlegt.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Artikelnr. Lieferant</th>
                  <th className="num">ab Menge</th>
                  <th className="num">Preis</th>
                  <th className="num">Lieferzeit</th>
                </tr>
              </thead>
              <tbody>
                {preise.map((v) => (
                  <tr key={v.id}>
                    <td>{v.artikel}</td>
                    <td className="mono small">{v.vendor_product_code ?? '—'}</td>
                    <td className="num">{qty(v.min_qty)}</td>
                    <td className="num nowrap">
                      {v.price.toLocaleString('de-DE', { maximumFractionDigits: 6 })} {v.currency}
                    </td>
                    <td className="num">{v.lead_time_days != null ? `${v.lead_time_days} T` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <RecordComments model="partner" recordId={id} path={`/einkauf/lieferanten/${id}`} />
    </>
  )
}
