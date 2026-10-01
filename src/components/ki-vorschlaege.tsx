import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card } from '@/components/ui'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { VORSCHLAG_ARTEN, type VorschlagArt } from '@/modules/ki/einkauf-prompt'
import { driveLink } from '@/modules/google/drive'
import { aktionsFelder } from '@/modules/prozesse/introspektion'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { dateTime } from '@/modules/shared/format'
import { vorschlagAendern, vorschlagAnnehmen, vorschlagVerwerfen } from '@/app/(erp)/einkauf/vorschlaege-actions'

/**
 * Baustein „KI-Vorschläge" (0109) für Thread, Einkaufsprojekt, Bestellung
 * und Lieferantenakte: was der Einkaufs-Agent vorschlägt — mit Begründung
 * und Quellen als Links, „Annehmen" (führt die Aktion als der Klickende
 * über den Torwächter aus), „Ändern" (Parameter vor dem Annehmen) und
 * „Verwerfen". Entschiedene der letzten 14 Tage stehen darunter. Ohne
 * Vorschläge erscheint die Karte nicht.
 */

interface Zeile {
  id: string
  aktion: string
  parameter: Record<string, unknown>
  art: VorschlagArt
  titel: string
  begruendung: string
  belege: { art: string; id: string; titel?: string }[]
  status: string
  quelle: string
  erstellt_am: string
  entschieden_von: string | null
  entschieden_am: string | null
  ergebnis: string | null
  ergebnis_link: string | null
  fehler: string | null
  geaendert_von: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ein Parameter als Formularfeld: Zahl, Ja/Nein, Text — Verschachteltes (Staffeln) als JSON. */
function Feld({ name, wert, hinweis }: { name: string; wert: unknown; hinweis?: string }) {
  if (wert !== null && typeof wert === 'object') {
    return (
      <label className="field" style={{ flexBasis: '100%' }}>
        <span title={hinweis}>{name} (JSON)</span>
        <textarea name={`j:${name}`} rows={Math.min(8, JSON.stringify(wert, null, 1).split('\n').length + 1)} defaultValue={JSON.stringify(wert, null, 1)} className="mono small" />
      </label>
    )
  }
  if (typeof wert === 'boolean') {
    return (
      <label className="field shrink">
        <span title={hinweis}>{name}</span>
        <input type="hidden" name={`t:${name}`} value="boolean" />
        <select name={`p:${name}`} defaultValue={String(wert)}>
          <option value="true">ja</option>
          <option value="false">nein</option>
        </select>
      </label>
    )
  }
  const zahl = typeof wert === 'number'
  return (
    <label className={zahl ? 'field shrink' : 'field'}>
      <span title={hinweis}>{name}</span>
      <input type="hidden" name={`t:${name}`} value={zahl ? 'number' : 'string'} />
      <input
        type="text"
        inputMode={zahl ? 'decimal' : undefined}
        name={`p:${name}`}
        defaultValue={zahl ? String(wert).replace('.', ',') : String(wert ?? '')}
        className={typeof wert === 'string' && UUID.test(wert) ? 'mono small' : undefined}
      />
    </label>
  )
}

export async function KiVorschlaegeKarte({
  threadId,
  einkaufsprojektId,
  purchaseOrderId,
  partnerId,
  pfad,
}: {
  threadId?: string
  einkaufsprojektId?: string
  purchaseOrderId?: string
  partnerId?: string
  pfad: string
}) {
  const filter = threadId
    ? sql`v.thread_id = ${threadId}`
    : einkaufsprojektId
      ? sql`v.einkaufsprojekt_id = ${einkaufsprojektId}`
      : purchaseOrderId
        ? sql`v.purchase_order_id = ${purchaseOrderId}`
        : sql`v.partner_id = ${partnerId ?? null}`
  const zeilen = await sql<Zeile[]>`
    select v.id, v.aktion, v.parameter, v.art, v.titel, v.begruendung, v.belege, v.status::text as status, v.quelle,
           v.erstellt_am::text as erstellt_am, v.entschieden_von, v.entschieden_am::text as entschieden_am,
           v.ergebnis, v.ergebnis_link, v.fehler, v.geaendert_von
    from ki_vorschlaege v
    where ${filter}
      and (v.status in ('offen', 'fehler') or v.entschieden_am > now() - interval '14 days')
    order by (v.status in ('offen', 'fehler')) desc, v.erstellt_am desc
    limit 30`
  if (zeilen.length === 0) return null

  // Quellen auflösen: Nachricht → ihr Thread, Dokument → Drive.
  const nachrichtIds = zeilen.flatMap((z) => z.belege.filter((b) => b.art === 'nachricht').map((b) => b.id))
  const dokumentIds = zeilen.flatMap((z) => z.belege.filter((b) => b.art === 'dokument').map((b) => b.id))
  const [nachrichten, dokumente] = await Promise.all([
    nachrichtIds.length
      ? sql<{ id: string; thread_id: string }[]>`select id, thread_id from mail_nachrichten where id = any(${nachrichtIds}::uuid[])`
      : [],
    dokumentIds.length
      ? sql<{ id: string; drive_file_id: string }[]>`select id, drive_file_id from dokumente where id = any(${dokumentIds}::uuid[])`
      : [],
  ])
  const threadVon = new Map(nachrichten.map((n) => [n.id, n.thread_id]))
  const driveVon = new Map(dokumente.map((d) => [d.id, d.drive_file_id]))
  const quelleLink = (b: { art: string; id: string }): string | null => {
    if (b.art === 'nachricht') return threadVon.has(b.id) ? `/einkauf/posteingang/${threadVon.get(b.id)}` : null
    if (b.art === 'dokument') return driveVon.has(b.id) ? driveLink(driveVon.get(b.id)!) : null
    if (b.art === 'bestellung') return `/einkauf/${b.id}`
    if (b.art === 'projekt') return `/einkauf/projekte/${b.id}`
    return null
  }

  const user = await currentUser()
  const darf = Boolean(user && canWrite(user.rollen, 'einkauf', user.befugnisse))
  const offen = zeilen.filter((z) => z.status === 'offen' || z.status === 'fehler').length

  return (
    <section id="ki-vorschlaege">
      <Card title={`KI-Vorschläge (${offen} offen)`} tight>
        <p className="small muted" style={{ margin: 0, padding: '8px 12px 0' }}>
          Vom Einkaufs-Agenten vorbereitet — ausgeführt wird erst mit „Annehmen", und zwar mit Ihren Rechten.
        </p>
        <ul className="dok-liste">
          {zeilen.map((z) => {
            const istOffen = z.status === 'offen' || z.status === 'fehler'
            const eintrag = registrierteAktion(z.aktion)
            const felder = new Map(eintrag ? aktionsFelder(eintrag).map((f) => [f.name, f.beschreibung]) : [])
            return (
              <li key={z.id} className="dok-zeile" style={{ alignItems: 'flex-start' }}>
                <div className="dok-text" style={{ flex: 1 }}>
                  <div>
                    <span className="badge info">{VORSCHLAG_ARTEN[z.art] ?? z.art}</span>{' '}
                    <strong>{z.titel}</strong> <Badge state={z.status} kind="ki_vorschlag" />
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>
                    {z.begruendung}
                  </div>
                  <div className="muted small" style={{ marginTop: 2 }}>
                    {z.belege.length > 0 && (
                      <>
                        Quellen:{' '}
                        {z.belege.map((b, i) => {
                          const link = quelleLink(b)
                          const text = b.titel ?? (b.art === 'nachricht' ? 'Nachricht' : b.art === 'dokument' ? 'Dokument' : b.art)
                          return (
                            <span key={`${b.art}:${b.id}`}>
                              {i > 0 ? ', ' : ''}
                              {link ? (
                                b.art === 'dokument' ? (
                                  <a href={link} target="_blank" rel="noopener">
                                    {text}
                                  </a>
                                ) : (
                                  <Link href={link}>{text}</Link>
                                )
                              ) : (
                                text
                              )}
                            </span>
                          )
                        })}
                        {' · '}
                      </>
                    )}
                    vom KI-Agenten · {dateTime(z.erstellt_am)}
                    {z.geaendert_von ? ` · geändert von ${z.geaendert_von}` : ''}
                    {z.entschieden_von && !istOffen ? ` · ${z.status === 'angenommen' ? 'angenommen' : 'verworfen'} von ${z.entschieden_von}` : ''}
                  </div>
                  {z.status === 'fehler' && z.fehler && (
                    <div className="small wv-ueberfaellig" style={{ marginTop: 4 }}>
                      Annehmen gescheitert: {z.fehler}
                    </div>
                  )}
                  {z.status === 'angenommen' && z.ergebnis && (
                    <div className="small muted" style={{ marginTop: 4 }}>
                      Ergebnis: {z.ergebnis}
                      {z.ergebnis_link ? (
                        <>
                          {' '}
                          <Link href={z.ergebnis_link}>öffnen</Link>
                        </>
                      ) : null}
                    </div>
                  )}
                  {darf && istOffen && (
                    <div className="actions" style={{ marginTop: 8 }}>
                      <ActionButton className="small primary" action={vorschlagAnnehmen.bind(null, z.id, pfad)}>
                        Annehmen
                      </ActionButton>
                      <ActionButton className="small" action={vorschlagVerwerfen.bind(null, z.id, pfad)}>
                        Verwerfen
                      </ActionButton>
                      <details>
                        <summary className="btn small">Ändern</summary>
                        <ActionForm action={vorschlagAendern.bind(null, z.id, pfad)} style={{ marginTop: 8 }}>
                          <div className="row">
                            {Object.entries(z.parameter).map(([name, wert]) => (
                              <Feld key={name} name={name} wert={wert} hinweis={felder.get(name)} />
                            ))}
                          </div>
                          <p className="small muted" style={{ margin: '6px 0' }}>
                            Leere Felder fallen weg. Geprüft wird gegen die Aktion; ausgeführt erst mit „Annehmen".
                          </p>
                          <button className="small" type="submit">
                            Speichern
                          </button>
                        </ActionForm>
                      </details>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
    </section>
  )
}
