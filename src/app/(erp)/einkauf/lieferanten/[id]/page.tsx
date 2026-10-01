import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { DokumenteKarte, groesseText } from '@/components/dokumente'
import { KiVorschlaegeKarte } from '@/components/ki-vorschlaege'
import { MailThreadsKarte, WiedervorlagenKarte } from '@/components/mail-threads'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { DOKUMENT_ARTEN } from '@/modules/einkauf/dokument-modelle'
import { rundeText } from '@/modules/einkauf/bemusterung'
import { VERTRAG_ARTEN, type VertragStatus, vertragsLage } from '@/modules/einkauf/lieferantenvertraege'
import { WERKZEUG_ARTEN } from '@/modules/einkauf/werkzeuge'
import { WerkzeugSchuesse } from '@/components/werkzeug-schuesse'
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
 * die Mail-Threads und Wiedervorlagen, seit Stufe 4 (0107) Verträge,
 * Werkzeuge und Muster.
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
  const heute = new Date().toISOString().slice(0, 10)

  const [einkaeufer, incoterms, waehrungen, bestellungen, rechnungen, preise, fremdeDateien, vertraege, werkzeuge, muster] = await Promise.all([
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
        tracking_url: string | null
      }[]
    >`
      select po.id, po.number, po.state, po.created_at::text as created_at, t.gross, po.currency,
             coalesce(po.eta_confirmed, po.expected_arrival)::text as eta, po.tracking_number, po.tracking_url
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
        template_id: string
        artikel: string
        min_qty: number
        price: number
        currency: string
        lead_time_days: number | null
        vendor_product_code: string | null
        vertrag_id: string | null
        vertrag: string | null
      }[]
    >`
      select vp.id, vp.template_id, pt.name as artikel, vp.min_qty::float as min_qty, vp.price::float as price, vp.currency,
             vp.lead_time_days, vp.vendor_product_code, vp.vertrag_id, lv.titel as vertrag
      from vendor_prices vp join product_templates pt on pt.id = vp.template_id
      left join lieferantenvertraege lv on lv.id = vp.vertrag_id
      where vp.vendor_id = ${id}
      order by pt.name, vp.min_qty limit 100`,
    // Dateien an Bestellungen/Rechnungen dieses Lieferanten (die eigenen zeigt die Karte darunter).
    sql<
      {
        id: string
        drive_file_id: string
        name: string
        art: keyof typeof DOKUMENT_ARTEN
        groesse: number | null
        belege: { pfad: string; nummer: string }[] | null
      }[]
    >`
      select d.id, d.drive_file_id, d.name, d.art::text as art, d.groesse::float as groesse,
             -- Querverweis: jeder Beleg mit Pfad, damit die Nummer klickbar ist.
             json_agg(json_build_object(
               'pfad', case when po.id is not null then '/einkauf/' || po.id else '/einkauf/rechnungen/' || vb.id end,
               'nummer', coalesce(po.number, vb.number)
             ) order by coalesce(po.number, vb.number)) filter (where po.id is not null or vb.id is not null) as belege
      from dokumente d
      join dokument_verweise v on v.dokument_id = d.id and v.modell <> 'partner'
      left join purchase_orders po on v.modell = 'purchase_order' and po.id = v.record_id
      left join vendor_bills vb on v.modell = 'vendor_bill' and vb.id = v.record_id
      where d.partner_id = ${id}
      group by d.id
      order by d.created_at desc limit 50`,
    // Stufe 4 (0107): Verträge, Werkzeuge, Muster des Lieferanten.
    sql<
      {
        id: string
        art: keyof typeof VERTRAG_ARTEN
        titel: string
        status: VertragStatus
        gueltig_bis: string | null
        ende: string | null
        stichtag: string | null
        erinnerung_tage: number
        preise: number
      }[]
    >`
      select v.id, v.art::text as art, v.titel, v.status::text as status, v.gueltig_bis::text as gueltig_bis,
             lieferantenvertrag_ende(v)::text as ende, lieferantenvertrag_stichtag(v)::text as stichtag, v.erinnerung_tage,
             (select count(*)::int from vendor_prices vp where vp.vertrag_id = v.id) as preise
      from lieferantenvertraege v where v.partner_id = ${id}
      order by v.status, lieferantenvertrag_stichtag(v) nulls last, v.titel`,
    sql<
      {
        id: string
        nummer: string
        bezeichnung: string
        art: keyof typeof WERKZEUG_ARTEN
        status: string
        schuss_zaehler: number
        lebensdauer_schuss: number | null
        projekt_id: string | null
        projekt_nummer: string | null
      }[]
    >`
      select w.id, w.nummer, w.bezeichnung, w.art, w.status::text as status, w.schuss_zaehler, w.lebensdauer_schuss,
             ep.id as projekt_id, ep.nummer as projekt_nummer
      from werkzeuge w left join einkaufsprojekte ep on ep.id = w.einkaufsprojekt_id
      where w.partner_id = ${id}
      order by w.status = 'ausgemustert', w.nummer`,
    sql<
      {
        id: string
        runde: number
        revision: string | null
        bezeichnung: string | null
        status: string
        golden: boolean
        erhalten_am: string | null
        projekt_id: string
        projekt_nummer: string
        projekt_titel: string
      }[]
    >`
      select b.id, b.runde, b.revision, b.bezeichnung, b.status::text as status, b.golden, b.erhalten_am::text as erhalten_am,
             ep.id as projekt_id, ep.nummer as projekt_nummer, ep.titel as projekt_titel
      from bemusterungen b join einkaufsprojekte ep on ep.id = b.projekt_id
      where b.partner_id = ${id}
      order by b.created_at desc limit 30`,
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

      <KiVorschlaegeKarte partnerId={id} pfad={`/einkauf/lieferanten/${id}`} />
      <MailThreadsKarte partnerId={id} />
      <WiedervorlagenKarte modell="partner" recordId={id} pfad={`/einkauf/lieferanten/${id}`} />
      <div id="dateien">
        <DokumenteKarte modell="partner" recordId={id} titel="Dateien des Lieferanten" />
      </div>

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
                    {d.belege?.map((b, i) => (
                      <span key={b.pfad}>
                        {i === 0 ? ' · ' : ', '}
                        <Link className="mono" href={b.pfad}>{b.nummer}</Link>
                      </span>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div id="bestellungen">
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
                      <Badge state={b.state} kind="purchase" href={`/einkauf/${b.id}`} />
                    </td>
                    <td className="mono small">{date(b.created_at)}</td>
                    <td className="mono small">{date(b.eta)}</td>
                    <td className="mono small">
                      {b.tracking_number && b.tracking_url?.startsWith('http') ? (
                        <a href={b.tracking_url} target="_blank" rel="noreferrer">{b.tracking_number}</a>
                      ) : (
                        (b.tracking_number ?? '—')
                      )}
                    </td>
                    <td className="num">{money(b.gross, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      </div>

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
                      <Badge state={r.state} kind="bill" href={`/einkauf/rechnungen/${r.id}`} />
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

      <div id="vertraege">
        <Card
          title={`Verträge (${vertraege.length})`}
          tight
          actions={
            <Link className="btn small" href={`/einkauf/vertraege?ansicht=alle&lieferant=${id}`}>
              Neuer Vertrag
            </Link>
          }
        >
          {vertraege.length === 0 ? (
            <Empty>Keine Verträge — NDA, QSV, Rahmenvertrag oder Preisliste anlegen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Vertrag</th>
                    <th>Läuft bis</th>
                    <th>Kündigen bis</th>
                    <th className="num">Preise</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vertraege.map((v) => {
                    const lage = vertragsLage(v, heute)
                    return (
                      <tr key={v.id}>
                        <td>
                          <Link href={`/einkauf/vertraege/${v.id}`}>{v.titel}</Link>
                          <div className="muted small">{VERTRAG_ARTEN[v.art]}</div>
                        </td>
                        <td className="small nowrap">{v.ende ? date(v.ende) : 'unbefristet'}</td>
                        <td className={`small nowrap${lage === 'faellig' || lage === 'abgelaufen' ? ' wv-ueberfaellig' : ''}`}>
                          {v.status === 'aktiv' && v.stichtag ? date(v.stichtag) : '—'}
                        </td>
                        <td className="num small">
                          {v.preise > 0 ? <Link href={`/einkauf/vertraege/${v.id}#preise`}>{v.preise}</Link> : '—'}
                        </td>
                        <td>
                          <Badge state={lage} kind="lieferantenvertrag" href={`/einkauf/vertraege/${v.id}`} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {werkzeuge.length > 0 && (
        <div id="werkzeuge">
          <Card
            title={`Werkzeuge beim Lieferanten (${werkzeuge.length})`}
            tight
            actions={
              <Link className="btn small" href={`/einkauf/werkzeuge?lieferant=${id}`}>
                Werkzeug anlegen
              </Link>
            }
          >
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Werkzeug</th>
                    <th>Projekt</th>
                    <th>Schuss</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {werkzeuge.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link href={`/einkauf/werkzeuge/${w.id}`}>
                          <span className="mono">{w.nummer}</span> {w.bezeichnung}
                        </Link>
                        <div className="muted small">{WERKZEUG_ARTEN[w.art] ?? w.art}</div>
                      </td>
                      <td className="small">
                        {w.projekt_id ? (
                          <Link className="mono" href={`/einkauf/projekte/${w.projekt_id}`}>
                            {w.projekt_nummer}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <WerkzeugSchuesse zaehler={w.schuss_zaehler} lebensdauerSchuss={w.lebensdauer_schuss} />
                      </td>
                      <td>
                        <Badge state={w.status} kind="werkzeug" href={`/einkauf/werkzeuge/${w.id}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}

      {muster.length > 0 && (
        <div id="muster">
          <Card title={`Muster (${muster.length})`} tight>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Muster</th>
                    <th>Projekt</th>
                    <th>Eingang</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {muster.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Link href={`/einkauf/muster/${m.id}`}>{rundeText(m)}</Link>
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/projekte/${m.projekt_id}`}>
                          <span className="mono">{m.projekt_nummer}</span> {m.projekt_titel}
                        </Link>
                      </td>
                      <td className="small nowrap">{m.erhalten_am ? date(m.erhalten_am) : m.status === 'offen' ? 'unterwegs' : '—'}</td>
                      <td className="nowrap">
                        <Badge state={m.status} kind="bemusterung" href={`/einkauf/muster/${m.id}`} />
                        {m.golden && <span className="badge success" style={{ marginLeft: 4 }}>Golden</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
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
                    <td>
                      <Link href={`/produkte/${v.template_id}`}>{v.artikel}</Link>
                    </td>
                    <td className="mono small">
                      {v.vendor_product_code ?? '—'}
                      {v.vertrag_id && (
                        <div>
                          <Link href={`/einkauf/vertraege/${v.vertrag_id}`}>{v.vertrag}</Link>
                        </div>
                      )}
                    </td>
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
