import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { ProzessPanel } from '@/components/prozess-panel'
import { dateTime, money, qty } from '@/modules/shared/format'
import { dhlConfigured } from '@/modules/versand/dhl'
import { retoureLabelSenden, retourePruefen } from '../actions'

export const dynamic = 'force-dynamic'

const PRUEFUNG_TEXT: Record<string, string> = {
  verkaufsfaehig: 'verkaufsfähig → Lager',
  bware: 'B-Ware',
  defekt: 'defekt → B-Ware',
}

/**
 * Retoure (0119): Positionen, Prüfung je Position (Fachmaske — die
 * generierte Prozessmaske könnte die Liste nur als JSON erfassen), Label,
 * Verlauf. Der Prozess-Panel bietet die übrigen Schritte an; nach einem Scan
 * (?schritt=eingang) steht „Ware eingegangen" sofort offen.
 */
export default async function RetourePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ schritt?: string }>
}) {
  const user = await requireArea('versand')
  const { id } = await params
  const { schritt: sofortOffen } = await searchParams

  const [r] = await sql<
    {
      id: string
      nummer: string
      status: string
      quelle: string
      email: string | null
      grund: string | null
      ablehnungsgrund: string | null
      fertigung_info: string | null
      shop_brutto_vorher: number | null
      shop_brutto_jetzt: number | null
      sales_order_id: string
      auftrag: string
      bestellung: string | null
      partner_id: string
      kunde: string
      picking_id: string | null
      transfer: string | null
      created_at: string
      genehmigt_am: string | null
      eingegangen_am: string | null
      geprueft_am: string | null
      erstattet_am: string | null
      abgeschlossen_am: string | null
    }[]
  >`
    select r.id, r.nummer, r.status::text as status, r.quelle, coalesce(r.email, so.ship_email, p.email) as email,
           r.grund, r.ablehnungsgrund, r.fertigung_info, r.shop_brutto_vorher, so.shopify_brutto as shop_brutto_jetzt,
           r.sales_order_id, so.number as auftrag, so.shopify_order_name as bestellung, r.partner_id,
           coalesce(so.ship_name, p.name) as kunde, r.picking_id, sp.number as transfer, r.created_at::text as created_at,
           r.genehmigt_am::text as genehmigt_am, r.eingegangen_am::text as eingegangen_am,
           r.geprueft_am::text as geprueft_am, r.erstattet_am::text as erstattet_am,
           r.abgeschlossen_am::text as abgeschlossen_am
    from retouren r
    join sales_orders so on so.id = r.sales_order_id
    join partners p on p.id = r.partner_id
    left join stock_pickings sp on sp.id = r.picking_id
    where r.id = ${id}`
  if (!r) notFound()

  const positionen = await sql<
    { id: string; bezeichnung: string; menge: number; grund: string | null; pruefung: string | null; pruef_notiz: string | null; variant_id: string }[]
  >`
    select id, bezeichnung, menge, grund, pruefung, pruef_notiz, variant_id
    from retoure_positionen where retoure_id = ${id} order by sequence`

  const labels = await sql<{ id: string; shipment_number: string; emailed_at: string | null; qr_link: string | null; created_at: string }[]>`
    select id, shipment_number, emailed_at::text as emailed_at, qr_link, created_at::text as created_at
    from return_labels where retoure_id = ${id} order by created_at desc`
  // Letzter Label-Fehler nach dem letzten Label (UX-Audit): stand bisher nur
  // im Verlauf — die Labelkarte sagte „Noch kein Label" ohne Grund.
  const [labelFehler] = await sql<{ message: string; created_at: string }[]>`
    select a.message, a.created_at from audit_log a
    where a.model = 'retoure' and a.record_id = ${id} and a.kind = 'error'
      and a.message like 'Retourenlabel fehlgeschlagen%'
      and a.created_at > coalesce((select max(created_at) from return_labels where retoure_id = ${id}), '-infinity')
    order by a.created_at desc limit 1`

  const zeitpunkte: [string, string | null][] = [
    ['Angefragt', r.created_at],
    ['Genehmigt', r.genehmigt_am],
    ['Eingegangen', r.eingegangen_am],
    ['Geprüft', r.geprueft_am],
    ['Erstattet (Shop)', r.erstattet_am],
    ['Abgeschlossen', r.abgeschlossen_am],
  ]

  return (
    <>
      <PageHeader
        title={<span className="mono">{r.nummer}</span>}
        subtitle={
          <>
            <Link href={`/kontakte/${r.partner_id}`}>{r.kunde}</Link>
            {' '}· Auftrag <Link className="mono" href={`/verkauf/${r.sales_order_id}`}>{r.bestellung ?? r.auftrag}</Link>
            {r.picking_id && <> · Rück-Transfer <Link className="mono" href={`/lager/${r.picking_id}`}>{r.transfer}</Link></>}
            {' '}· {r.quelle === 'shop' ? 'aus dem Portal im Shop' : 'intern angelegt'}
          </>
        }
        actions={
          <>
            <Badge state={r.status} kind="retoure" />
            <Link className="btn" href="/versand/retouren">Alle Retouren</Link>
          </>
        }
      />

      <div className="grid-2">
        <Card title="Anfrage">
          <dl className="kv">
            <dt>Anliegen</dt>
            <dd>{r.grund ?? '—'}</dd>
            <dt>Antwortadresse</dt>
            <dd>{r.email ?? <span className="muted">keine — Mails gehen nicht raus</span>}</dd>
            {r.ablehnungsgrund && (
              <>
                <dt>Ablehnung</dt>
                <dd>{r.ablehnungsgrund}</dd>
              </>
            )}
            <dt>Shop-Betrag</dt>
            <dd>
              {r.shop_brutto_vorher != null ? money(r.shop_brutto_vorher) : '—'} bei Anfrage
              {r.shop_brutto_jetzt != null && r.shop_brutto_jetzt !== r.shop_brutto_vorher && <> · jetzt {money(r.shop_brutto_jetzt)}</>}
            </dd>
            {r.fertigung_info && (
              <>
                <dt>Fertigung</dt>
                <dd>{r.fertigung_info}</dd>
              </>
            )}
          </dl>
        </Card>
        <Card title="Verlauf">
          <dl className="kv">
            {zeitpunkte.map(([label, wann]) => (
              <span key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd className="mono small">{wann ? dateTime(wann) : '—'}</dd>
              </span>
            ))}
          </dl>
          {r.status === 'geprueft' && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Wartet auf die Erstattung im Shopify-Admin — sobald der Shop erstattet, schließt KRNL die Retoure selbst ab.
            </p>
          )}
        </Card>
      </div>

      <Card title={`Positionen (${positionen.length})`} tight>
        {r.status === 'eingegangen' ? (
          <ActionForm action={retourePruefen.bind(null, id)}>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="num">Menge</th>
                    <th>Grund</th>
                    <th>Prüfung</th>
                    <th>Notiz</th>
                  </tr>
                </thead>
                <tbody>
                  {positionen.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/produkte/variante/${p.variant_id}`}>{p.bezeichnung}</Link></td>
                      <td className="num">{qty(p.menge)}</td>
                      <td className="muted">{p.grund ?? '—'}</td>
                      <td>
                        <Auswahl name={`pruefung_${p.id}`} required defaultValue="">
                          <option value="" disabled>— prüfen —</option>
                          <option value="verkaufsfaehig">verkaufsfähig</option>
                          <option value="bware">B-Ware</option>
                          <option value="defekt">defekt</option>
                        </Auswahl>
                      </td>
                      <td><input name={`notiz_${p.id}`} placeholder="optional" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="row" style={{ padding: 12, alignItems: 'center' }}>
              <p className="small muted" style={{ margin: 0, flex: 1 }}>
                Verkaufsfähig geht zurück ins Lager und ist sofort wieder verkaufbar; wartende Lieferungen bekommen es
                reserviert. B-Ware und Defekt landen auf WH/B-Ware — nur markiert, zählt nirgends.
              </p>
              <div className="shrink">
                <button className="primary" type="submit">Prüfung buchen</button>
              </div>
            </div>
          </ActionForm>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="num">Menge</th>
                  <th>Grund</th>
                  <th>Prüfung</th>
                </tr>
              </thead>
              <tbody>
                {positionen.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/produkte/variante/${p.variant_id}`}>{p.bezeichnung}</Link></td>
                    <td className="num">{qty(p.menge)}</td>
                    <td className="muted">{p.grund ?? '—'}</td>
                    <td>
                      {p.pruefung ? (
                        <span className={`badge ${p.pruefung === 'verkaufsfaehig' ? 'ok' : 'warn'}`}>{PRUEFUNG_TEXT[p.pruefung]}</span>
                      ) : (
                        <span className="muted">offen</span>
                      )}
                      {p.pruef_notiz && <div className="small muted">{p.pruef_notiz}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {(labels.length > 0 || r.status === 'genehmigt') && (
        <Card title="Retourenlabel">
          {labels.length === 0 ? (
            <p className="small muted" style={{ marginTop: 0 }}>
              Noch kein Label{dhlConfigured() ? '' : ' — DHL ist nicht konfiguriert'}.
            </p>
          ) : (
            <ul className="small" style={{ marginTop: 0 }}>
              {labels.map((l) => (
                <li key={l.id}>
                  <span className="mono">{l.shipment_number}</span> ·{' '}
                  {l.emailed_at ? `gemailt ${dateTime(l.emailed_at)}` : 'Mail in der Warteschlange'}
                  {l.qr_link && (
                    <>
                      {' '}· <a href={l.qr_link} target="_blank" rel="noreferrer">QR-Code</a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {labelFehler && (
            <p className="small" style={{ marginTop: 0 }}>
              <span className="badge danger">Fehler</span> {labelFehler.message.replace(/^Retourenlabel fehlgeschlagen: /, '')}{' '}
              <span className="muted">({dateTime(labelFehler.created_at)})</span>
            </p>
          )}
          {r.status === 'genehmigt' && dhlConfigured() && (
            <ActionButton action={retoureLabelSenden.bind(null, id)}>
              {labels.length === 0 ? 'Retourenlabel senden' : 'Neues Retourenlabel senden'}
            </ActionButton>
          )}
        </Card>
      )}

      <ProzessPanel prozessCode="retoure" recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} sofortOffen={sofortOffen} />

      <RecordComments model="retoure" recordId={id} path={`/versand/retouren/${id}`} />
    </>
  )
}
