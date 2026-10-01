import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { DokumenteKarte } from '@/components/dokumente'
import { WiedervorlagenKarte } from '@/components/mail-threads'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { MIT_PREISEN, VERTRAG_ARTEN, type VertragArt, type VertragStatus, vertragsLage } from '@/modules/einkauf/lieferantenvertraege'
import { date, qty } from '@/modules/shared/format'
import { preislisteUebernehmen, vertragAendern, vertragStatusSetzen } from '../actions'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ein Lieferantenvertrag (0107): Laufzeit, Kündigungsstichtag, Verlängerung,
 * Status (gekündigt/beendet), die Vertragsdatei als Dokument und — bei
 * Preisliste oder Rahmenvertrag — die Übernahme in Lieferantenpreise mit
 * der Gültigkeit des Vertrags.
 */
export default async function VertragPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const pfad = `/einkauf/vertraege/${id}`
  const heute = new Date().toISOString().slice(0, 10)

  const [v] = await sql<
    {
      id: string
      art: VertragArt
      titel: string
      status: VertragStatus
      gueltig_von: string | null
      gueltig_bis: string | null
      ende: string | null
      stichtag: string | null
      kuendigungsfrist_monate: number
      verlaengerung_monate: number | null
      erinnerung_tage: number
      waehrung: string
      gekuendigt_am: string | null
      notiz: string | null
      partner_id: string
      lieferant: string
    }[]
  >`
    select v.id, v.art::text as art, v.titel, v.status::text as status, v.gueltig_von::text as gueltig_von,
           v.gueltig_bis::text as gueltig_bis, lieferantenvertrag_ende(v)::text as ende,
           lieferantenvertrag_stichtag(v)::text as stichtag, v.kuendigungsfrist_monate, v.verlaengerung_monate,
           v.erinnerung_tage, v.waehrung, v.gekuendigt_am::text as gekuendigt_am, v.notiz,
           pa.id as partner_id, pa.name as lieferant
    from lieferantenvertraege v join partners pa on pa.id = v.partner_id
    where v.id = ${id}`
  if (!v) notFound()

  const [preise, waehrungen] = await Promise.all([
    sql<
      { id: string; template_id: string; artikel: string; min_qty: number; price: number; currency: string; lead_time_days: number; date_start: string | null; date_end: string | null }[]
    >`
      select vp.id, vp.template_id, variant_display_name(coalesce(vp.variant_id,
               (select pv.id from product_variants pv where pv.template_id = vp.template_id limit 1))) as artikel,
             vp.min_qty::float as min_qty, vp.price::float as price, vp.currency, vp.lead_time_days,
             vp.date_start::text as date_start, vp.date_end::text as date_end
      from vendor_prices vp where vp.vertrag_id = ${id}
      order by 2, vp.min_qty`,
    sql<{ code: string }[]>`select code from currencies where active order by code = 'EUR' desc, code`,
  ])
  const lage = vertragsLage(v, heute)
  const mitPreisen = MIT_PREISEN.includes(v.art)

  return (
    <>
      <PageHeader
        kicker={`Lieferantenvertrag · ${VERTRAG_ARTEN[v.art]}`}
        title={v.titel}
        subtitle={
          <>
            <Badge state={lage} kind="lieferantenvertrag" led /> mit{' '}
            <Link href={`/einkauf/lieferanten/${v.partner_id}`}>{v.lieferant}</Link>
          </>
        }
        actions={
          <Link className="btn" href="/einkauf/vertraege">
            Alle Verträge
          </Link>
        }
      />

      <Card title="Vertrag">
        <dl className="kv">
          <dt>Laufzeit</dt>
          <dd>
            {v.gueltig_von ? date(v.gueltig_von) : 'offen'} – {v.gueltig_bis ? date(v.gueltig_bis) : 'unbefristet'}
          </dd>
          {v.verlaengerung_monate && (
            <>
              <dt>Verlängerung</dt>
              <dd>
                um {v.verlaengerung_monate} Monate, wenn nicht gekündigt
                {v.ende && v.ende !== v.gueltig_bis ? ` — läuft derzeit bis ${date(v.ende)}` : ''}
              </dd>
            </>
          )}
          <dt>Kündigungsfrist</dt>
          <dd>
            {v.kuendigungsfrist_monate > 0 ? `${v.kuendigungsfrist_monate} Monate` : 'keine'}
            {v.status === 'aktiv' && v.stichtag ? ` · kündigen bis ${date(v.stichtag)}` : ''}
          </dd>
          <dt>Erinnerung</dt>
          <dd>{v.erinnerung_tage} Tage vor dem Stichtag</dd>
          {mitPreisen && (
            <>
              <dt>Währung der Preise</dt>
              <dd className="mono">{v.waehrung}</dd>
            </>
          )}
          {v.gekuendigt_am && (
            <>
              <dt>Gekündigt am</dt>
              <dd>{date(v.gekuendigt_am)}</dd>
            </>
          )}
          {v.notiz && (
            <>
              <dt>Notiz</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{v.notiz}</dd>
            </>
          )}
        </dl>

        {darf && (
          <ActionForm action={vertragStatusSetzen.bind(null, id)} style={{ marginTop: 12 }}>
            <div className="row">
              <label className="field shrink">
                <span>Status</span>
                <select name="status" defaultValue={v.status === 'aktiv' ? 'gekuendigt' : 'aktiv'}>
                  {v.status === 'aktiv' && <option value="gekuendigt">Gekündigt (läuft bis zum Ende)</option>}
                  {v.status !== 'beendet' && <option value="beendet">Beendet (endet zum Datum)</option>}
                  {v.status !== 'aktiv' && <option value="aktiv">Wieder aktiv</option>}
                </select>
              </label>
              <label className="field shrink">
                <span>Datum (leer = heute)</span>
                <input type="date" name="datum" />
              </label>
              <label className="field">
                <span>Notiz</span>
                <input name="notiz" placeholder="z. B. per Mail an den Vertrieb gekündigt" />
              </label>
              <div className="shrink field">
                <button type="submit" className="small">Status setzen</button>
              </div>
            </div>
          </ActionForm>
        )}

        {darf && (
          <details style={{ marginTop: 10 }}>
            <summary className="small">Bearbeiten</summary>
            <ActionForm action={vertragAendern.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Titel</span>
                  <input name="titel" defaultValue={v.titel} required />
                </label>
                <label className="field">
                  <span>Art</span>
                  <select name="art" defaultValue={v.art}>
                    {Object.entries(VERTRAG_ARTEN).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field shrink">
                  <span>Währung</span>
                  <select name="waehrung" defaultValue={v.waehrung} className="mono">
                    {waehrungen.map((w) => (
                      <option key={w.code} value={w.code}>
                        {w.code}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row">
                <label className="field shrink">
                  <span>Gültig von</span>
                  <input type="date" name="gueltig_von" defaultValue={v.gueltig_von ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Gültig bis</span>
                  <input type="date" name="gueltig_bis" defaultValue={v.gueltig_bis ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Kündigungsfrist (Monate)</span>
                  <input name="kuendigungsfrist_monate" inputMode="numeric" defaultValue={v.kuendigungsfrist_monate} />
                </label>
                <label className="field shrink">
                  <span>Verlängerung (Monate)</span>
                  <input name="verlaengerung_monate" inputMode="numeric" defaultValue={v.verlaengerung_monate ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Erinnern (Tage)</span>
                  <input name="erinnerung_tage" inputMode="numeric" defaultValue={v.erinnerung_tage} />
                </label>
              </div>
              <label className="field">
                <span>Notiz</span>
                <textarea name="notiz" rows={2} defaultValue={v.notiz ?? ''} />
              </label>
              <button type="submit" className="small">Speichern</button>
            </ActionForm>
          </details>
        )}
      </Card>

      {mitPreisen && (
        <div id="preise">
          <Card title={`Lieferantenpreise aus dem Vertrag (${preise.length})`} tight>
            {preise.length === 0 ? (
              <Empty>Noch keine Preise übernommen.</Empty>
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      <th className="num">ab Menge</th>
                      <th className="num">Preis</th>
                      <th className="num">Lieferzeit</th>
                      <th>Gültig</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preise.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/produkte/${p.template_id}`}>{p.artikel}</Link>
                        </td>
                        <td className="num">{qty(p.min_qty)}</td>
                        <td className="num nowrap">
                          {p.price.toLocaleString('de-DE', { maximumFractionDigits: 6 })} {p.currency}
                        </td>
                        <td className="num">{p.lead_time_days} T</td>
                        <td className="small nowrap">
                          {p.date_start ? date(p.date_start) : 'offen'} – {p.date_end ? date(p.date_end) : 'offen'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {darf && v.status !== 'beendet' && (
              <div style={{ padding: '10px 12px' }}>
                <span className="mono-label">{preise.length ? 'Preisliste neu übernehmen' : 'Preisliste übernehmen'}</span>
                <ActionForm action={preislisteUebernehmen.bind(null, id)} style={{ marginTop: 6 }}>
                  <label className="field">
                    <span>Eine Zeile je Preis: „Artikel / ab Menge: Preis" (auch aus Excel: SKU⇥Menge⇥Preis)</span>
                    <textarea
                      name="text"
                      rows={6}
                      className="mono"
                      required
                      placeholder={'KC-PBT-01 / 500: 7,20\nKC-PBT-01 / 1000: 6,85\nKC-PULL: 0,35'}
                    />
                  </label>
                  <div className="row">
                    <label className="field shrink">
                      <span>Lieferzeit (Tage)</span>
                      <input name="lieferzeit_tage" inputMode="numeric" placeholder="30" />
                    </label>
                    <div className="shrink field">
                      <button type="submit" className="small primary">Übernehmen</button>
                    </div>
                  </div>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    Preise in {v.waehrung}, gültig wie der Vertrag. Ersetzt alle Preise, die schon aus diesem Vertrag stammen;
                    eine unlesbare Zeile oder ein unbekannter Artikel verhindert die Übernahme.
                  </p>
                </ActionForm>
              </div>
            )}
          </Card>
        </div>
      )}

      <DokumenteKarte modell="lieferantenvertrag" recordId={id} titel="Vertragsdateien" />
      <WiedervorlagenKarte modell="lieferantenvertrag" recordId={id} pfad={pfad} />
      <RecordComments model="lieferantenvertrag" recordId={id} path={pfad} />
    </>
  )
}
