import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { groesseText } from '@/components/dokumente'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, PageHeader } from '@/components/ui'
import { DOKUMENT_ARTEN } from '@/modules/einkauf/dokument-modelle'
import { zitatTrennen } from '@/modules/einkauf/mail-zerlegen'
import { SPRACHEN, offenePlatzhalter } from '@/modules/einkauf/mail-vorlagen'
import { MAX_ANHANG_BYTES, versandText } from '@/modules/einkauf/mail-senden'
import { driveLink } from '@/modules/google/drive'
import { uebersetzungMoeglich } from '@/modules/ki/uebersetzen'
import { dateTime } from '@/modules/shared/format'
import { entwurfBearbeiten, entwurfVerwerfen } from '../actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ein Mail-Entwurf (0094): links Deutsch zum Mitlesen, rechts der Text in
 * der Sprache des Lieferanten, dazwischen die Übersetzung per KI. Anhänge
 * kommen aus der Ablage (Thread, Lieferant, Bestellung). „Senden" speichert
 * und gibt frei; gesendet wird innerhalb einer Minute im Thread.
 */
export default async function EntwurfPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const [e] = await sql<
    {
      id: string
      status: string
      thread_id: string | null
      thread_betreff: string | null
      partner_id: string | null
      lieferant: string | null
      purchase_order_id: string | null
      bestellung: string | null
      einkaufsprojekt_id: string | null
      projekt: string | null
      an: string[]
      cc: string[]
      betreff: string
      text_de: string
      text_ziel: string | null
      sprache: 'de' | 'en' | 'zh'
      anhang_dokument_ids: string[]
      antwort_erwartet_bis: string | null
      quelle: string
      erstellt_von: string | null
      freigegeben_von: string | null
      freigegeben_am: string | null
      gesendet_am: string | null
      fehler: string | null
    }[]
  >`
    select e.id, e.status::text as status, e.thread_id, t.betreff as thread_betreff, e.partner_id, p.name as lieferant,
           e.purchase_order_id, po.number as bestellung, e.einkaufsprojekt_id, ep.nummer as projekt, e.an, e.cc, e.betreff, e.text_de, e.text_ziel, e.sprache,
           e.anhang_dokument_ids, e.antwort_erwartet_bis::text as antwort_erwartet_bis, e.quelle, e.erstellt_von,
           e.freigegeben_von, e.freigegeben_am::text as freigegeben_am, e.gesendet_am::text as gesendet_am, e.fehler
    from mail_entwuerfe e
    left join mail_threads t on t.id = e.thread_id
    left join partners p on p.id = e.partner_id
    left join purchase_orders po on po.id = e.purchase_order_id
    left join einkaufsprojekte ep on ep.id = e.einkaufsprojekt_id
    where e.id = ${id}`
  if (!e) notFound()

  // Anhang-Kandidaten: alles, was an Thread, Lieferant oder Bestellung hängt (plus schon gewählte).
  const [kandidaten, verlauf] = await Promise.all([
    sql<{ id: string; name: string; art: keyof typeof DOKUMENT_ARTEN; groesse: number | null; drive_file_id: string }[]>`
      select distinct on (d.id) d.id, d.name, d.art::text as art, d.groesse::float as groesse, d.drive_file_id
      from dokumente d
      left join dokument_verweise v on v.dokument_id = d.id
      where d.id = any(${e.anhang_dokument_ids}::uuid[])
         or (v.modell = 'mail_thread' and v.record_id = ${e.thread_id})
         or (v.modell = 'partner' and v.record_id = ${e.partner_id})
         or (v.modell = 'purchase_order' and v.record_id = ${e.purchase_order_id})
      order by d.id, d.created_at desc
      limit 80`,
    e.thread_id
      ? sql<{ id: string; richtung: string; von: string | null; von_name: string | null; datum: string; text: string | null; text_de: string | null }[]>`
          select id, richtung::text as richtung, von, von_name, datum::text as datum, text, text_de
          from mail_nachrichten where thread_id = ${e.thread_id} order by datum desc limit 2`
      : Promise.resolve([]),
  ])
  const gewaehlt = new Set(e.anhang_dokument_ids)
  const summe = kandidaten.filter((k) => gewaehlt.has(k.id)).reduce((a, k) => a + (k.groesse ?? 0), 0)
  const offen = offenePlatzhalter(`${e.betreff}\n${versandText(e)}`)
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const bearbeitbar = darf && e.status === 'entwurf'
  const zielName = SPRACHEN[e.sprache]
  const ki = uebersetzungMoeglich()

  return (
    <>
      <PageHeader
        kicker={e.quelle === 'agent' ? 'Mail-Entwurf · vom Agenten' : 'Mail-Entwurf'}
        title={e.betreff || '(ohne Betreff)'}
        subtitle={
          <>
            {e.partner_id ? <Link href={`/einkauf/lieferanten/${e.partner_id}`}>{e.lieferant}</Link> : 'ohne Lieferant'}
            {e.purchase_order_id && (
              <>
                {' · '}
                <Link href={`/einkauf/${e.purchase_order_id}`}>{e.bestellung}</Link>
              </>
            )}
            {e.einkaufsprojekt_id && (
              <>
                {' · Projekt '}
                <Link href={`/einkauf/projekte/${e.einkaufsprojekt_id}`}>{e.projekt}</Link>
              </>
            )}
            {e.thread_id && (
              <>
                {' · '}
                <Link href={`/einkauf/posteingang/${e.thread_id}`}>Thread: {e.thread_betreff ?? 'öffnen'}</Link>
              </>
            )}
            {` · ${zielName}`}
          </>
        }
        actions={
          <>
            <Badge
              state={e.status}
              kind="mail_entwurf"
              led
              href={e.status === 'gesendet' && e.thread_id ? `/einkauf/posteingang/${e.thread_id}` : undefined}
              title={e.status === 'gesendet' && e.thread_id ? 'Zum Gespräch' : undefined}
            />
            {bearbeitbar && (
              <ActionButton action={entwurfVerwerfen.bind(null, id)} confirm="Entwurf verwerfen?" className="danger">
                Verwerfen
              </ActionButton>
            )}
          </>
        }
      />

      {e.fehler && (
        <Card title="Senden fehlgeschlagen">
          <p className="small" style={{ margin: 0 }}>
            {e.fehler} — der Versuch wird automatisch wiederholt; Einzelheiten im Job-Monitor.
          </p>
        </Card>
      )}

      {bearbeitbar ? (
        <Card title="Mail">
          <ActionForm action={entwurfBearbeiten.bind(null, id)}>
            <div className="row">
              <label className="field" style={{ flex: 2 }}>
                <span>An</span>
                <input name="an" className="mono" defaultValue={e.an.join(', ')} placeholder="sales@lieferant.cn" />
              </label>
              <label className="field">
                <span>Cc</span>
                <input name="cc" className="mono" defaultValue={e.cc.join(', ')} />
              </label>
              <label className="field shrink">
                <span>Sprache</span>
                <Auswahl name="sprache" defaultValue={e.sprache}>
                  <option value="de">Deutsch</option>
                  <option value="en">Englisch</option>
                  <option value="zh">Chinesisch</option>
                </Auswahl>
              </label>
            </div>
            <label className="field">
              <span>Betreff</span>
              <input name="betreff" defaultValue={e.betreff} maxLength={300} />
            </label>

            <div className="entwurf-texte">
              <label className="field">
                <span>Deutsch {e.sprache !== 'de' && '(zum Mitlesen)'}</span>
                <textarea name="text_de" rows={14} defaultValue={e.text_de} />
              </label>
              {e.sprache !== 'de' && (
                <label className="field">
                  <span>{zielName} (wird gesendet)</span>
                  <textarea name="text_ziel" rows={14} defaultValue={e.text_ziel ?? ''} />
                </label>
              )}
            </div>
            {e.sprache !== 'de' && (
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="small" type="submit" name="_aktion" value="uebersetzen_ziel" disabled={!ki}>
                  Deutsch → {zielName} übersetzen
                </button>
                <button className="small" type="submit" name="_aktion" value="uebersetzen_de" disabled={!ki}>
                  {zielName} → Deutsch
                </button>
                {!ki && <span className="muted small">Übersetzen braucht die KI (ANTHROPIC_API_KEY).</span>}
              </div>
            )}

            <input type="hidden" name="anhaenge_gezeigt" value="1" />
            <div className="field" style={{ marginTop: 12 }}>
              <span>Anhänge aus der Ablage {summe > 0 && `— ${groesseText(summe)} gewählt`}</span>
              {kandidaten.length === 0 ? (
                <p className="muted small" style={{ margin: '4px 0 0' }}>
                  Keine Dateien an Thread, Lieferant oder Bestellung — erst dort hochladen.
                </p>
              ) : (
                <ul className="entwurf-anhaenge">
                  {kandidaten.map((k) => (
                    <li key={k.id}>
                      <label>
                        <input type="checkbox" name="anhang" value={k.id} defaultChecked={gewaehlt.has(k.id)} />{' '}
                        <span className="dok-name">{k.name}</span>{' '}
                        <span className="muted small">
                          {DOKUMENT_ARTEN[k.art] ?? k.art} · {groesseText(k.groesse)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {summe > MAX_ANHANG_BYTES && (
                <p className="small wv-ueberfaellig" style={{ margin: '4px 0 0' }}>
                  Mehr als 18 MB — große Dateien bitte per Drive-Link oder WeTransfer teilen.
                </p>
              )}
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <label className="field shrink">
                <span>Antwort erwartet bis</span>
                <input type="date" name="antwort_erwartet_bis" defaultValue={e.antwort_erwartet_bis ?? ''} />
              </label>
              <div className="field shrink">
                <button className="small" type="submit" name="_aktion" value="speichern">
                  Speichern
                </button>
              </div>
              <div className="field shrink">
                <button className="primary" type="submit" name="_aktion" value="senden">
                  Senden
                </button>
              </div>
            </div>
            {offen.length > 0 && (
              <p className="small wv-ueberfaellig" style={{ margin: '8px 0 0' }}>
                Noch offene Platzhalter: {offen.map((o) => `[${o}]`).join(', ')} — vor dem Senden ausfüllen.
              </p>
            )}
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              „Senden" speichert, gibt frei und schickt die Mail über das Einkaufspostfach
              {e.thread_id ? ' im bestehenden Thread' : ''}. Mit „Antwort erwartet bis" entsteht eine Wiedervorlage.
            </p>
          </ActionForm>
        </Card>
      ) : (
        <Card title={e.status === 'gesendet' ? `Gesendet ${dateTime(e.gesendet_am)}` : 'Mail'}>
          <div className="small muted" style={{ marginBottom: 8 }}>
            an {e.an.join(', ') || '—'}
            {e.cc.length > 0 && ` · cc ${e.cc.join(', ')}`}
            {e.freigegeben_von && ` · freigegeben von ${e.freigegeben_von} ${dateTime(e.freigegeben_am)}`}
          </div>
          <div className="entwurf-texte">
            {e.sprache !== 'de' && <div className="mail-text">{e.text_ziel}</div>}
            <div className="mail-text muted">{e.text_de}</div>
          </div>
          {kandidaten.filter((k) => gewaehlt.has(k.id)).length > 0 && (
            <ul className="mail-anhaenge">
              {kandidaten
                .filter((k) => gewaehlt.has(k.id))
                .map((k) => (
                  <li key={k.id}>
                    <a href={driveLink(k.drive_file_id)} target="_blank" rel="noopener">
                      📎 {k.name}
                    </a>{' '}
                    <span className="muted small">{groesseText(k.groesse)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      )}

      {verlauf.length > 0 && (
        <Card title="Worauf du antwortest" tight>
          <ul className="dok-liste">
            {verlauf.map((n) => (
              <li key={n.id} className="dok-zeile" style={{ display: 'block' }}>
                <div className="muted small">
                  {n.richtung === 'ausgang' ? '→' : '←'} {n.von_name || n.von} · {dateTime(n.datum)}
                </div>
                <div className="mail-text">{zitatTrennen(n.text ?? '').neu}</div>
                {n.text_de && <div className="mail-text muted small" style={{ marginTop: 6 }}>DE: {zitatTrennen(n.text_de).neu}</div>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ProzessPanel prozessCode="mail_versand" recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} nurDiagramm />
      <RecordComments model="mail_entwurf" recordId={id} path={`/einkauf/entwuerfe/${id}`} />
    </>
  )
}
