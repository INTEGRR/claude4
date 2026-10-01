import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty } from '@/components/ui'
import { date, dateTime } from '@/modules/shared/format'
import { wiedervorlageAnlegen, wiedervorlageErledigen } from '@/app/(erp)/einkauf/posteingang/actions'
import { entwurfAnlegen } from '@/app/(erp)/einkauf/entwuerfe/actions'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { VORLAGEN_ANLAESSE } from '@/modules/einkauf/mail-vorlagen'
import type { WiedervorlageModell } from '@/modules/prozesse/registry/einkauf-postfach'

/**
 * Bausteine des Einkaufspostfachs (0093) für Lieferantenakte, Bestellung und
 * Thread: die Mail-Threads eines Belegs und seine Wiedervorlagen.
 */

export const KANAL_NAMEN: Record<string, string> = {
  email: 'Mail',
  alibaba: 'Alibaba',
  telefon: 'Telefon',
  sonstiges: 'Sonstiges',
}

export async function MailThreadsKarte({
  partnerId,
  purchaseOrderId,
  einkaufsprojektId,
  lieferanten = [],
}: {
  partnerId?: string
  purchaseOrderId?: string
  /** Threads eines Einkaufsprojekts (0097); „Neue Mail" geht dann an einen der `lieferanten`. */
  einkaufsprojektId?: string
  lieferanten?: { id: string; name: string }[]
}) {
  const threads = await sql<
    {
      id: string
      betreff: string | null
      status: string
      kanal: string
      letzte_richtung: string | null
      letzte_am: string | null
      anzahl: number
      bestellung: string | null
      purchase_order_id: string | null
      lieferant: string | null
      partner_id: string | null
    }[]
  >`
    select t.id, t.betreff, t.status::text as status, t.kanal::text as kanal, t.letzte_richtung::text as letzte_richtung,
           t.letzte_am::text as letzte_am, t.anzahl, po.number as bestellung, t.purchase_order_id, pa.name as lieferant, t.partner_id
    from mail_threads t
    left join purchase_orders po on po.id = t.purchase_order_id
    left join partners pa on pa.id = t.partner_id
    where t.status <> 'ignoriert'
      and ${
        einkaufsprojektId
          ? sql`t.einkaufsprojekt_id = ${einkaufsprojektId}`
          : purchaseOrderId
            ? sql`t.purchase_order_id = ${purchaseOrderId}`
            : sql`t.partner_id = ${partnerId ?? null}`
      }
    order by t.letzte_am desc nulls last
    limit 30`
  const user = await currentUser()
  const darf = Boolean(user && canWrite(user.rollen, 'einkauf', user.befugnisse))

  return (
    <Card
      title={`Mails & Nachrichten (${threads.length})`}
      tight
      actions={
        <Link className="btn small" href="/einkauf/posteingang">
          Posteingang
        </Link>
      }
    >
      {threads.length === 0 ? (
        <Empty>Noch keine Mails zu diesem {einkaufsprojektId ? 'Projekt' : purchaseOrderId ? 'Beleg' : 'Lieferanten'}.</Empty>
      ) : (
        <ul className="dok-liste">
          {threads.map((t) => (
            <li key={t.id} className="dok-zeile">
              <div className="dok-text">
                <Link href={`/einkauf/posteingang/${t.id}`} className="dok-name">
                  {t.betreff || '(ohne Betreff)'}
                </Link>
                <div className="muted small">
                  {t.letzte_richtung === 'ausgang' ? '→ wartet auf Lieferant' : '← wartet auf uns'} · {dateTime(t.letzte_am)} ·{' '}
                  {t.anzahl} Nachricht{t.anzahl === 1 ? '' : 'en'}
                  {t.kanal !== 'email' ? ` · ${KANAL_NAMEN[t.kanal]}` : ''}
                  {t.bestellung && t.purchase_order_id && !purchaseOrderId && (
                    <>
                      {' · '}
                      <Link href={`/einkauf/${t.purchase_order_id}`}>{t.bestellung}</Link>
                    </>
                  )}
                  {t.lieferant && t.partner_id && !partnerId && (
                    <>
                      {' · '}
                      <Link href={`/einkauf/lieferanten/${t.partner_id}`}>{t.lieferant}</Link>
                    </>
                  )}
                </div>
              </div>
              <Badge state={t.status} kind="mail_thread" />
            </li>
          ))}
        </ul>
      )}
      {darf && (!einkaufsprojektId || lieferanten.length > 0) && (
        <ActionForm action={entwurfAnlegen} style={{ padding: '10px 12px' }}>
          {einkaufsprojektId ? (
            <input type="hidden" name="einkaufsprojekt_id" value={einkaufsprojektId} />
          ) : purchaseOrderId ? (
            <input type="hidden" name="purchase_order_id" value={purchaseOrderId} />
          ) : (
            <input type="hidden" name="partner_id" value={partnerId} />
          )}
          <div className="row">
            {einkaufsprojektId && (
              <label className="field">
                <span>An</span>
                <select name="partner_id" required>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>Neue Mail</span>
              <select name="vorlage" defaultValue={purchaseOrderId ? 'liefertermin' : einkaufsprojektId ? '' : 'anfrage'}>
                <option value="">— freier Text —</option>
                {Object.entries(VORLAGEN_ANLAESSE).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {purchaseOrderId && (
              <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" name="bestell_pdf" />
                <span>Bestell-PDF anhängen</span>
              </label>
            )}
            <div className="field shrink">
              <button className="small" type="submit">
                Mail entwerfen
              </button>
            </div>
          </div>
        </ActionForm>
      )}
    </Card>
  )
}

/** Wohin eine regelbasierte Wiedervorlage führt (Sicht einkauf_regel_wiedervorlagen, 0107). */
export const REGEL_ZIEL: Record<string, (id: string) => string> = {
  lieferantenvertrag: (id) => `/einkauf/vertraege/${id}`,
  werkzeug: (id) => `/einkauf/werkzeuge/${id}`,
}

/** In 7 Tagen, als JJJJ-MM-TT — Vorgabe für neue Wiedervorlagen. */
function inTagen(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
}

export async function WiedervorlagenKarte({
  modell,
  recordId,
  pfad,
}: {
  modell: WiedervorlageModell
  recordId: string
  pfad: string
}) {
  const [liste, nutzer, regeln] = await Promise.all([
    sql<{ id: string; faellig_am: string; grund: string; zustaendig: string | null; ueberfaellig: boolean }[]>`
      select w.id, w.faellig_am::text as faellig_am, w.grund, u.name as zustaendig,
             w.faellig_am < current_date as ueberfaellig
      from wiedervorlagen w left join users u on u.id = w.zustaendig_id
      where w.modell = ${modell} and w.record_id = ${recordId} and w.erledigt_am is null
      order by w.faellig_am`,
    sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
    // Regelbasierte Wiedervorlagen (0107): am Beleg selbst, in der Lieferantenakte alle des Lieferanten.
    sql<{ modell: string; record_id: string; grund: string; frist: string | null; ueberfaellig: boolean }[]>`
      select r.modell, r.record_id, r.grund, r.frist::text as frist,
             coalesce(r.frist, r.faellig_am) < current_date as ueberfaellig
      from einkauf_regel_wiedervorlagen r
      where (r.modell = ${modell} and r.record_id = ${recordId})
         or (${modell} = 'partner' and r.partner_id = ${recordId})
      order by r.faellig_am`,
  ])

  return (
    <Card title={`Wiedervorlagen (${liste.length + regeln.length})`} tight>
      {regeln.length > 0 && (
        <ul className="dok-liste">
          {regeln.map((r) => (
            <li key={`${r.modell}:${r.record_id}`} className="dok-zeile">
              <div className="dok-text">
                <span className={r.ueberfaellig ? 'dok-name wv-ueberfaellig' : 'dok-name'}>{r.grund}</span>
                <div className="muted small">
                  <span className="mono-label">Regel</span>
                  {r.frist ? ` · Frist ${date(r.frist)}` : ''}
                  {r.ueberfaellig ? ' · überfällig' : ''} · verschwindet von selbst, sobald der Grund behoben ist
                  {modell === 'partner' && (
                    <>
                      {' · '}
                      <Link href={REGEL_ZIEL[r.modell]?.(r.record_id) ?? '#'}>öffnen</Link>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {liste.length > 0 && (
        <ul className="dok-liste">
          {liste.map((w) => (
            <li key={w.id} className="dok-zeile">
              <div className="dok-text">
                <span className={w.ueberfaellig ? 'dok-name wv-ueberfaellig' : 'dok-name'}>{w.grund}</span>
                <div className="muted small">
                  fällig {date(w.faellig_am)}
                  {w.ueberfaellig ? ' · überfällig' : ''}
                  {w.zustaendig ? ` · ${w.zustaendig}` : ''}
                </div>
              </div>
              <ActionButton className="small" action={wiedervorlageErledigen.bind(null, w.id, pfad)}>
                Erledigt
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      <ActionForm action={wiedervorlageAnlegen.bind(null, pfad)} style={{ padding: '10px 12px' }}>
        <input type="hidden" name="modell" value={modell} />
        <input type="hidden" name="record_id" value={recordId} />
        <div className="row">
          <label className="field" style={{ flex: 2 }}>
            <span>Grund</span>
            <input name="grund" required maxLength={300} placeholder="z. B. Antwort zum Preis erwartet" />
          </label>
          <label className="field shrink">
            <span>Fällig am</span>
            <input name="faellig_am" type="date" required defaultValue={inTagen(7)} />
          </label>
          <label className="field shrink">
            <span>Zuständig</span>
            <select name="zustaendig_id" defaultValue="">
              <option value="">ich</option>
              {nutzer.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field shrink">
            <button className="small" type="submit">
              Vormerken
            </button>
          </div>
        </div>
      </ActionForm>
    </Card>
  )
}
