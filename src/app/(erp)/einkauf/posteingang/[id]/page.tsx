import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { DokumenteKarte, groesseText } from '@/components/dokumente'
import { MailHtml } from '@/components/mail-html'
import { KANAL_NAMEN, WiedervorlagenKarte } from '@/components/mail-threads'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, PageHeader } from '@/components/ui'
import { zitatTrennen } from '@/modules/einkauf/mail-zerlegen'
import { absenderKennung } from '@/modules/einkauf/mail-regeln'
import { driveLink } from '@/modules/google/drive'
import { dateTime } from '@/modules/shared/format'
import { mailStatusSetzen, mailZuordnen, nachrichtErfassen } from '../actions'
import { entwurfAnlegen, nachrichtUebersetzen } from '../../entwuerfe/actions'
import { VORLAGEN_ANLAESSE } from '@/modules/einkauf/mail-vorlagen'
import { uebersetzungMoeglich } from '@/modules/ki/uebersetzen'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DURCH: Record<string, string> = { regel: 'automatisch (Regel)', mensch: 'von Hand', agent: 'vom Agenten' }

/**
 * Ein Gesprächsfaden (0093): alle Nachrichten in zeitlicher Folge — das
 * Neue offen, zitierte Verläufe eingeklappt, ältere Nachrichten zu. Dazu
 * Zuordnung (Lieferant, Bestellung, Zuständig), Status, Anhänge aus der
 * Ablage, von Hand erfasste Antworten, Wiedervorlagen und Verlauf.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const [t] = await sql<
    {
      id: string
      betreff: string | null
      status: string
      kanal: string
      partner_id: string | null
      lieferant: string | null
      purchase_order_id: string | null
      bestellung: string | null
      zustaendig_id: string | null
      zugeordnet_durch: string | null
    }[]
  >`
    select t.id, t.betreff, t.status::text as status, t.kanal::text as kanal, t.partner_id, p.name as lieferant,
           t.purchase_order_id, po.number as bestellung, t.zustaendig_id, t.zugeordnet_durch::text as zugeordnet_durch
    from mail_threads t
    left join partners p on p.id = t.partner_id
    left join purchase_orders po on po.id = t.purchase_order_id
    where t.id = ${id}`
  if (!t) notFound()

  const [nachrichten, anhaenge, lieferanten, bestellungen, nutzer, entwuerfe] = await Promise.all([
    sql<
      {
        id: string
        richtung: string
        kanal: string
        von: string | null
        von_name: string | null
        an: string[]
        cc: string[]
        betreff: string | null
        datum: string
        text: string | null
        text_de: string | null
        sprache: string | null
        hat_html: boolean
        quelle: string
        erfasst_von: string | null
      }[]
    >`
      select id, richtung::text as richtung, kanal::text as kanal, von, von_name, an, cc, betreff,
             datum::text as datum, text, text_de, sprache, html is not null as hat_html, quelle, erfasst_von
      from mail_nachrichten where thread_id = ${id}
      order by datum, created_at`,
    sql<
      {
        nachricht_id: string
        dateiname: string
        groesse: number | null
        fehler: string | null
        drive_file_id: string | null
      }[]
    >`
      select a.nachricht_id, a.dateiname, a.groesse::float as groesse, a.fehler, d.drive_file_id
      from mail_anhaenge a
      join mail_nachrichten n on n.id = a.nachricht_id
      left join dokumente d on d.id = a.dokument_id
      where n.thread_id = ${id}
      order by a.created_at`,
    sql<{ id: string; name: string }[]>`
      select id, name from partners
      where (is_vendor and active and parent_id is null) or id = ${t.partner_id}
      order by name`,
    sql<{ id: string; number: string; lieferant: string }[]>`
      select po.id, po.number, p.name as lieferant
      from purchase_orders po join partners p on p.id = po.vendor_id
      where (po.state <> 'cancel' and po.created_at > now() - interval '18 months') or po.id = ${t.purchase_order_id}
      order by (po.vendor_id = ${t.partner_id}) desc nulls last, po.created_at desc
      limit 300`,
    sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
    sql<{ id: string; betreff: string; status: string; erstellt_von: string | null }[]>`
      select id, betreff, status::text as status, erstellt_von from mail_entwuerfe
      where thread_id = ${id} and status in ('entwurf', 'freigegeben') order by created_at`,
  ])

  const ki = uebersetzungMoeglich()
  const darf = canWrite(user.role, 'einkauf', user.befugnisse)
  const ersterEingang = nachrichten.find((n) => n.richtung === 'eingang' && n.von?.includes('@'))
  const kennungRoh = ersterEingang?.von ? absenderKennung(ersterEingang.von) : null
  // Schon in einer Lieferantenakte hinterlegt → nichts mehr zu merken.
  const [bekannt] = kennungRoh
    ? await sql<{ ja: boolean }[]>`select exists (select 1 from partners where ${kennungRoh} = any(mail_domains)) as ja`
    : [{ ja: true }]
  const kennung = bekannt.ja ? null : kennungRoh
  const pfad = `/einkauf/posteingang/${id}`

  return (
    <>
      <PageHeader
        kicker={t.kanal === 'email' ? 'Mail-Thread' : KANAL_NAMEN[t.kanal]}
        title={t.betreff || '(ohne Betreff)'}
        subtitle={
          <>
            {t.partner_id ? <Link href={`/einkauf/lieferanten/${t.partner_id}`}>{t.lieferant}</Link> : 'nicht zugeordnet'}
            {t.bestellung && t.purchase_order_id ? (
              <>
                {' · '}
                <Link href={`/einkauf/${t.purchase_order_id}`}>{t.bestellung}</Link>
              </>
            ) : null}
            {t.zugeordnet_durch ? ` · zugeordnet ${DURCH[t.zugeordnet_durch]}` : ''}
          </>
        }
        actions={
          darf ? (
            <>
              <Badge state={t.status} kind="mail_thread" led />
              {t.status !== 'erledigt' && (
                <ActionButton className="primary" action={mailStatusSetzen.bind(null, id, 'erledigt')}>
                  Erledigt
                </ActionButton>
              )}
              {t.status !== 'offen' && (
                <ActionButton action={mailStatusSetzen.bind(null, id, 'offen')}>Wieder öffnen</ActionButton>
              )}
              {t.status === 'offen' && (
                <ActionButton action={mailStatusSetzen.bind(null, id, 'ignoriert')} title="Newsletter, Spam — kommt nicht zurück in den Posteingang">
                  Ignorieren
                </ActionButton>
              )}
            </>
          ) : (
            <Badge state={t.status} kind="mail_thread" led />
          )
        }
      />

      <div className="mail-verlauf">
        {nachrichten.map((n, i) => {
          const { neu, zitat } = zitatTrennen(n.text ?? '')
          const eigene = anhaenge.filter((a) => a.nachricht_id === n.id)
          const offen = i >= nachrichten.length - 2
          const kopf = (
            <div className="mail-kopf">
              <span className={`mail-richtung ${n.richtung}`}>{n.richtung === 'ausgang' ? '→' : '←'}</span>
              <strong>{n.von_name || n.von || (n.richtung === 'ausgang' ? 'wir' : 'Lieferant')}</strong>
              {n.von_name && n.von ? <span className="muted small mono"> {n.von}</span> : null}
              <span className="muted small mail-datum">{dateTime(n.datum)}</span>
            </div>
          )
          return (
            <details key={n.id} className={`mail-nachricht ${n.richtung}`} open={offen}>
              <summary>
                {kopf}
                {!offen && <div className="muted small mail-vorschau">{neu.slice(0, 140)}</div>}
              </summary>
              <div className="mail-meta muted small">
                {n.an.length > 0 && <div>an {n.an.join(', ')}</div>}
                {n.cc.length > 0 && <div>cc {n.cc.join(', ')}</div>}
                {n.quelle === 'weitergeleitet' && <div>weitergeleitet von {n.erfasst_von}</div>}
                {n.quelle === 'manuell' && (
                  <div>
                    {KANAL_NAMEN[n.kanal]} · von Hand erfasst von {n.erfasst_von}
                  </div>
                )}
                {n.betreff && n.betreff !== t.betreff && <div>Betreff: {n.betreff}</div>}
              </div>
              <div className="mail-text">{neu || <span className="muted">(kein Text)</span>}</div>
              {n.text_de && (
                <div className="mail-de">
                  <div className="muted small">Deutsch (übersetzt)</div>
                  <div className="mail-text">{zitatTrennen(n.text_de).neu}</div>
                </div>
              )}
              {!n.text_de && darf && ki && n.sprache && n.sprache !== 'de' && neu && (
                <div style={{ marginTop: 8 }}>
                  <ActionButton className="small" action={nachrichtUebersetzen.bind(null, n.id, pfad)}>
                    Ins Deutsche übersetzen
                  </ActionButton>
                </div>
              )}
              {zitat && (
                <details className="mail-zitat">
                  <summary className="small muted">Zitierten Verlauf anzeigen</summary>
                  <div className="mail-text muted">{zitat}</div>
                </details>
              )}
              {eigene.length > 0 && (
                <ul className="mail-anhaenge">
                  {eigene.map((a, j) => (
                    <li key={j}>
                      {a.drive_file_id ? (
                        <a href={driveLink(a.drive_file_id)} target="_blank" rel="noopener">
                          📎 {a.dateiname}
                        </a>
                      ) : (
                        <span>📎 {a.dateiname}</span>
                      )}{' '}
                      <span className="muted small">
                        {groesseText(a.groesse)}
                        {!a.drive_file_id && (a.fehler ? ` · ${a.fehler}` : ' · wird abgelegt …')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {n.hat_html && <MailHtml nachrichtId={n.id} />}
            </details>
          )
        })}
      </div>

      {darf && (
        <Card title="Antworten">
          {entwuerfe.length > 0 && (
            <ul className="dok-liste" style={{ marginBottom: 10 }}>
              {entwuerfe.map((d) => (
                <li key={d.id} className="dok-zeile">
                  <Link href={`/einkauf/entwuerfe/${d.id}`} className="dok-name">
                    {d.betreff || '(ohne Betreff)'}
                  </Link>
                  <span className="muted small">
                    <Badge state={d.status} kind="mail_entwurf" /> {d.erstellt_von}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={entwurfAnlegen}>
            <input type="hidden" name="thread_id" value={id} />
            <div className="row">
              <label className="field">
                <span>Vorlage</span>
                <select name="vorlage" defaultValue="">
                  <option value="">— freier Text —</option>
                  {Object.entries(VORLAGEN_ANLAESSE)
                    .filter(([k]) => k !== 'anfrage' && k !== 'bestellung')
                    .map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              <div className="field shrink">
                <button className="primary" type="submit">
                  Antwort entwerfen
                </button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Im Entwurf: Deutsch schreiben, per KI in die Sprache des Lieferanten übersetzen, Anhänge aus der
              Ablage wählen, senden — im selben Thread.
            </p>
          </ActionForm>
        </Card>
      )}

      {darf && (
        <Card title="Zuordnung">
          <ActionForm action={mailZuordnen.bind(null, id)}>
            <div className="row">
              <label className="field">
                <span>Lieferant</span>
                <select name="partner_id" defaultValue={t.partner_id ?? ''}>
                  <option value="">— aus der Bestellung —</option>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Bestellung</span>
                <select name="purchase_order_id" defaultValue={t.purchase_order_id ?? ''}>
                  <option value="">—</option>
                  {bestellungen.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · {b.lieferant}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Zuständig</span>
                <select name="zustaendig_id" defaultValue={t.zustaendig_id ?? ''}>
                  <option value="">— Einkäufer des Lieferanten —</option>
                  {nutzer.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field shrink">
                <button className="primary" type="submit">
                  Zuordnen
                </button>
              </div>
            </div>
            {kennung && (
              <label className="small" style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" name="absender_merken" defaultChecked={!t.partner_id} />
                <span>
                  <span className="mono">{kennung}</span> in der Lieferantenakte merken — künftige Mails werden
                  automatisch zugeordnet
                </span>
              </label>
            )}
          </ActionForm>
        </Card>
      )}

      {darf && (
        <Card title="Antwort oder Gespräch von Hand erfassen">
          <ActionForm action={nachrichtErfassen}>
            <input type="hidden" name="thread_id" value={id} />
            <div className="row">
              <label className="field shrink">
                <span>Kanal</span>
                <select name="kanal" defaultValue={t.kanal === 'email' ? 'telefon' : t.kanal}>
                  <option value="alibaba">Alibaba</option>
                  <option value="telefon">Telefon</option>
                  <option value="sonstiges">Sonstiges</option>
                  <option value="email">Mail (anderes Postfach)</option>
                </select>
              </label>
              <label className="field shrink">
                <span>Richtung</span>
                <select name="richtung" defaultValue="eingang">
                  <option value="eingang">vom Lieferanten</option>
                  <option value="ausgang">von uns</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Inhalt</span>
              <textarea name="text" rows={3} required />
            </label>
            <div style={{ marginTop: 8 }}>
              <button className="small" type="submit">
                Erfassen
              </button>
            </div>
          </ActionForm>
        </Card>
      )}

      <WiedervorlagenKarte modell="mail_thread" recordId={id} pfad={pfad} />
      <DokumenteKarte modell="mail_thread" recordId={id} titel="Dateien des Threads" />
      <RecordComments model="mail_thread" recordId={id} path={pfad} />
    </>
  )
}
