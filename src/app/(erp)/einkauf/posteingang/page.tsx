import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { KANAL_NAMEN } from '@/components/mail-threads'
import { Badge, Card, Empty, PageHeader, TableWrap, Zustand } from '@/components/ui'
import { postfachStand } from '@/modules/einkauf/postfach-abgleich'
import { postfachKonfiguriert } from '@/modules/google/auth'
import { dateTime } from '@/modules/shared/format'
import { nachrichtErfassen, postfachAbgleichen } from './actions'
import { Auswahl } from '@/components/auswahl'
import { kurzLieferant } from '@/app/(erp)/kurzanlage'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'offen', label: 'Offen' },
  { key: 'uns', label: 'Wartet auf uns' },
  { key: 'lieferant', label: 'Wartet auf Lieferant' },
  { key: 'ohne', label: 'Nicht zugeordnet' },
  { key: 'meine', label: 'Meine' },
  { key: 'erledigt', label: 'Erledigt' },
  { key: 'alle', label: 'Alle' },
] as const
type Ansicht = (typeof ANSICHTEN)[number]['key']

/**
 * Posteingang des Einkaufs (0093): alle Gesprächsfäden aus dem
 * Einkaufspostfach und den von Hand erfassten Kanälen. Die Regel ordnet
 * zu, was sie erkennt (Maildomain, Bestellnummer) — hier landet der Rest,
 * und hier sieht jeder Einkäufer, wo er dran ist.
 */
export default async function PosteingangPage({
  searchParams,
}: {
  searchParams: Promise<{ ansicht?: string; q?: string }>
}) {
  const user = await requireArea('einkauf')
  const sp = await searchParams
  const ansicht: Ansicht = ANSICHTEN.some((a) => a.key === sp.ansicht) ? (sp.ansicht as Ansicht) : 'offen'
  const q = (sp.q ?? '').trim()

  const filter = {
    offen: sql`t.status = 'offen'`,
    uns: sql`t.status = 'offen' and t.letzte_richtung = 'eingang'`,
    lieferant: sql`t.status = 'offen' and t.letzte_richtung = 'ausgang'`,
    ohne: sql`t.status = 'offen' and t.partner_id is null`,
    meine: sql`t.status = 'offen' and t.zustaendig_id = ${user.id}`,
    erledigt: sql`t.status = 'erledigt'`,
    alle: sql`true`,
  }[ansicht]

  const [threads, zahlen, lieferanten, stand] = await Promise.all([
    sql<
      {
        id: string
        betreff: string | null
        status: string
        kanal: string
        letzte_richtung: string | null
        letzte_am: string | null
        anzahl: number
        lieferant: string | null
        partner_id: string | null
        purchase_order_id: string | null
        bestellung: string | null
        projekt_id: string | null
        projekt: string | null
        zustaendig: string | null
        vorschau: string | null
        von: string | null
        anhaenge: number
      }[]
    >`
      select t.id, t.betreff, t.status::text as status, t.kanal::text as kanal,
             t.letzte_richtung::text as letzte_richtung, t.letzte_am::text as letzte_am, t.anzahl,
             p.name as lieferant, t.partner_id, t.purchase_order_id, po.number as bestellung,
             t.einkaufsprojekt_id as projekt_id, ep.nummer as projekt, u.name as zustaendig,
             left(regexp_replace(coalesce(l.text, ''), '\\s+', ' ', 'g'), 160) as vorschau,
             coalesce(l.von_name, l.von) as von,
             (select count(*)::int from mail_anhaenge a join mail_nachrichten n on n.id = a.nachricht_id
               where n.thread_id = t.id and a.fehler is null) as anhaenge
      from mail_threads t
      left join partners p on p.id = t.partner_id
      left join purchase_orders po on po.id = t.purchase_order_id
      left join einkaufsprojekte ep on ep.id = t.einkaufsprojekt_id
      left join users u on u.id = t.zustaendig_id
      left join lateral (
        select n.text, n.von, n.von_name from mail_nachrichten n where n.thread_id = t.id
        order by n.datum desc limit 1
      ) l on true
      where ${filter}
        and (${q === ''} or t.betreff ilike ${'%' + q + '%'} or p.name ilike ${'%' + q + '%'}
             or exists (select 1 from mail_nachrichten n
                        where n.thread_id = t.id
                          and (n.suche @@ plainto_tsquery('simple', ${q}) or n.von ilike ${'%' + q + '%'})))
      order by t.letzte_am desc nulls last
      limit 200`,
    sql<{ offen: number; uns: number; ohne: number; meine: number }[]>`
      select count(*) filter (where status = 'offen')::int as offen,
             count(*) filter (where status = 'offen' and letzte_richtung = 'eingang')::int as uns,
             count(*) filter (where status = 'offen' and partner_id is null)::int as ohne,
             count(*) filter (where status = 'offen' and zustaendig_id = ${user.id})::int as meine
      from mail_threads`,
    sql<{ id: string; name: string }[]>`
      select id, name from partners where is_vendor and active and parent_id is null order by name`,
    postfachStand(),
  ])
  const z = zahlen[0]
  const zaehler: Partial<Record<Ansicht, number>> = { offen: z.offen, uns: z.uns, ohne: z.ohne, meine: z.meine }
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const angebunden = postfachKonfiguriert()

  return (
    <>
      <PageHeader
        title="Posteingang"
        subtitle="Mails aus dem Einkaufspostfach und erfasste Alibaba-Chats und Telefonate — zugeordnet zu Lieferant und Bestellung"
        actions={
          <Link className="btn" href="/einkauf/wiedervorlagen">
            Wiedervorlagen
          </Link>
        }
      />

      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => {
            const aktiv = a.key === ansicht
            const n = zaehler[a.key]
            return (
              <Link
                key={a.key}
                href={`/einkauf/posteingang?ansicht=${a.key}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                className="btn small"
                aria-current={aktiv ? 'page' : undefined}
              >
                <span className={aktiv ? 'led on' : 'led off'} />
                {a.label}
                {n ? <span className="mono-label"> {n}</span> : null}
              </Link>
            )
          })}
        </div>
        <form method="get" className="row" style={{ padding: '0 12px 10px' }}>
          <input type="hidden" name="ansicht" value={ansicht} />
          <label className="field">
            <span>Suche (Betreff, Lieferant, Absender, Text)</span>
            <input name="q" defaultValue={q} placeholder="z. B. PCB rev C, tracking, 样品" />
          </label>
          <div className="shrink field">
            <button className="small" type="submit">
              Suchen
            </button>
          </div>
        </form>
        {threads.length === 0 ? (
          <Empty>{q ? 'Nichts gefunden.' : 'Hier ist gerade nichts.'}</Empty>
        ) : (
          <TableWrap>
            <table className="posteingang">
              <thead>
                <tr>
                  <th>Betreff</th>
                  <th>Lieferant</th>
                  <th>Zuständig</th>
                  <th>Zuletzt</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {threads.map((t) => (
                  <tr key={t.id}>
                    <td className="pe-betreff">
                      <Link href={`/einkauf/posteingang/${t.id}`}>{t.betreff || '(ohne Betreff)'}</Link>
                      <div className="muted small pe-vorschau">
                        {t.von ? <strong>{t.von}: </strong> : null}
                        {t.vorschau}
                      </div>
                    </td>
                    <td>
                      {t.partner_id ? (
                        <Link href={`/einkauf/lieferanten/${t.partner_id}`}>{t.lieferant}</Link>
                      ) : (
                        <span className="badge warn">nicht zugeordnet</span>
                      )}
                      {(t.purchase_order_id || t.projekt_id) && (
                        <div className="mono small">
                          {t.purchase_order_id && <Link href={`/einkauf/${t.purchase_order_id}`}>{t.bestellung}</Link>}
                          {t.purchase_order_id && t.projekt_id ? ' · ' : ''}
                          {t.projekt_id && <Link href={`/einkauf/projekte/${t.projekt_id}`}>{t.projekt}</Link>}
                        </div>
                      )}
                    </td>
                    <td className="small">{t.zustaendig ?? '—'}</td>
                    <td className="small nowrap">
                      <span title={t.letzte_richtung === 'ausgang' ? 'zuletzt wir' : 'zuletzt Lieferant'}>
                        {t.letzte_richtung === 'ausgang' ? '→' : '←'}
                      </span>{' '}
                      {dateTime(t.letzte_am)}
                      <div className="muted">
                        {t.anzahl} Nachr.
                        {t.anhaenge ? ` · ${t.anhaenge} Anh.` : ''}
                        {t.kanal !== 'email' ? ` · ${KANAL_NAMEN[t.kanal]}` : ''}
                      </div>
                    </td>
                    <td>
                      <Badge state={t.status} kind="mail_thread" href={`/einkauf/posteingang/${t.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darf && (
        <Card title="Alibaba-Chat, Telefonat o. Ä. erfassen">
          <ActionForm action={nachrichtErfassen}>
            <div className="row">
              <label className="field shrink">
                <span>Kanal</span>
                <Auswahl name="kanal" defaultValue="alibaba">
                  <option value="alibaba">Alibaba</option>
                  <option value="telefon">Telefon</option>
                  <option value="sonstiges">Sonstiges (WeChat …)</option>
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Richtung</span>
                <Auswahl name="richtung" defaultValue="eingang">
                  <option value="eingang">vom Lieferanten</option>
                  <option value="ausgang">von uns</option>
                </Auswahl>
              </label>
              <label className="field">
                <span>Lieferant</span>
                <Auswahl kurzanlage={kurzLieferant(user)} name="partner_id" required defaultValue="">
                  <option value="" disabled>
                    — wählen —
                  </option>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Betreff</span>
                <input name="betreff" maxLength={300} placeholder="z. B. Foam-Einlage 40×30, Preisanfrage" />
              </label>
            </div>
            <label className="field">
              <span>Inhalt (Chat-Text einfügen oder Gesprächsnotiz)</span>
              <textarea name="text" rows={4} required />
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <div className="field shrink">
                <button className="primary" type="submit">
                  Erfassen
                </button>
              </div>
              <p className="small muted" style={{ margin: 0, alignSelf: 'center' }}>
                Screenshots danach im Thread unter „Dokumente" hochladen.
              </p>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card title="Einkaufspostfach">
        <div className="row" style={{ alignItems: 'center' }}>
          {angebunden ? (
            <Zustand ton={stand.letzter_lauf ? 'ok' : 'off'}>
              {stand.adresse ?? 'angebunden'} · {stand.letzter_lauf ? `zuletzt abgeglichen ${dateTime(stand.letzter_lauf)}` : 'noch nicht abgeglichen'}
            </Zustand>
          ) : (
            <Zustand ton="off">nicht angebunden — Einstellungen → Schnittstellen → Google</Zustand>
          )}
          {angebunden && user.role === 'admin' && (
            <div className="shrink" style={{ marginLeft: 'auto' }}>
              <ActionButton className="small" action={postfachAbgleichen}>
                Jetzt abgleichen
              </ActionButton>
            </div>
          )}
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          KRNL liest das Postfach jede Minute. Alt-Threads aus persönlichen Postfächern einfach an das
          Einkaufspostfach weiterleiten — der ursprüngliche Absender wird erkannt.
        </p>
      </Card>
    </>
  )
}
