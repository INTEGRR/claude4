import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import type { Area } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { FeldEingabe } from '@/components/feld-eingabe'
import { ProzessAktionen } from '@/components/prozess-aktionen'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { Card, PageHeader } from '@/components/ui'
import { naechsteAngebote } from '@/modules/prozesse/angebote'
import type { FormularFeld } from '@/modules/prozesse/schema-felder'
import { dateTime } from '@/modules/shared/format'
import { vorgangKopfAendern } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Ein generischer Vorgang als ECHTE MASKE (Kanon der Fachbeleg-Seiten):
 * Kopf mit übersetztem Zustand, editierbare Details-Karte (Titel, Kunde,
 * alle eigenen Felder mit Ist-Werten), „Als Nächstes möglich" als eigene
 * Arbeitskarte — und der Ablaufplan als einklappbarer Kontext am Seitenende
 * statt als dominierender erster Block. Die Seite kennt keinen Prozess beim
 * Namen; alles kommt aus der Definition.
 */
export default async function VorgangDetail({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [v] = await sql<
    {
      id: string
      number: string
      prozess_code: string
      prozess_name: string
      bereich: string
      titel: string | null
      state: string
      partner: string | null
      partner_id: string | null
      zusatz: Record<string, unknown>
      created_at: string
    }[]
  >`
    select v.id, v.number, v.prozess_code, p.name as prozess_name, p.bereich,
           v.titel, v.state, pa.name as partner, v.partner_id, v.zusatz, v.created_at
    from vorgaenge v
    join prozesse p on p.code = v.prozess_code
    left join partners pa on pa.id = v.partner_id
    where v.id = ${id}`
  if (!v) notFound()

  // Rechte am Bereich des Prozesses — ein Personalablauf gehört hinter die
  // Personalschranke, nicht pauschal hinter den Verkauf (wie die Liste).
  const user = await requireArea(v.bereich as Area)

  // Der Zustand in Kundensprache: der Schritt, der ihn gesetzt hat.
  const [zustandsSchritt] = await sql<{ name: string }[]>`
    select name from prozess_schritte
    where version_id = prozess_aktive_version(${v.prozess_code}) and zustand = ${v.state}
    limit 1`

  // Alle eigenen Felder des Ablaufs — mit Typ/Auswahl, denn hier wird
  // EDITIERT, nicht nur angezeigt.
  const defs = await sql<
    { name: string; label: string; typ: string; auswahl: string[] | null }[]
  >`
    select name, label, typ, auswahl from feld_definitionen
    where modell = 'vorgang' and (prozess_code is null or prozess_code = ${v.prozess_code})
    order by prozess_code nulls last, sequence, name`
  const zusatz = v.zusatz ?? {}
  const bekannt = new Set(defs.map((f) => f.name))
  // Werte ohne Definition (Feld nachträglich entfernt) gehen nicht verloren.
  const verwaist = Object.entries(zusatz).filter(([name]) => !bekannt.has(name))

  const felder: FormularFeld[] = defs.map((f) => ({
    name: `zusatz.${f.name}`,
    label: f.label,
    typ: f.typ as FormularFeld['typ'],
    // Bewusst ohne Pflicht: das ist die Korrektur-Maske. Pflicht erzwingt
    // die Schrittmaske — hier würde sie das Speichern anderer Felder blockieren.
    pflicht: false,
    ...(f.auswahl?.length ? { auswahl: f.auswahl } : {}),
    ...(zusatz[f.name] != null ? { vorgabe: zusatz[f.name] } : {}),
  }))

  const partner = await sql<{ id: string; name: string }[]>`
    select id, name from partners order by name limit 500`

  const { angebote, passiv } = await naechsteAngebote(
    v.prozess_code,
    v.id,
    user.role,
    user.befugnisse,
  )

  return (
    <>
      <PageHeader
        title={<span className="mono">{v.number}</span>}
        subtitle={
          <>
            {v.prozess_name}
            {v.titel && <> · {v.titel}</>}
            {' '}· angelegt <span className="mono">{dateTime(v.created_at)}</span>
          </>
        }
        actions={
          <>
            <span className="badge info">{zustandsSchritt?.name ?? v.state}</span>
            <Link className="btn" href={`/vorgaenge/prozess/${v.prozess_code}`}>
              Alle „{v.prozess_name}"
            </Link>
            <Link className="btn" href="/vorgaenge">Alle Vorgänge</Link>
          </>
        }
      />

      <Card title="Als Nächstes möglich">
        {angebote.length === 0 && passiv.length === 0 ? (
          <span className="muted small">
            Nichts — der Ablauf ist am Ende oder wartet. Die Felder unten bleiben trotzdem
            korrigierbar.
          </span>
        ) : (
          <>
            {angebote.length > 0 && <ProzessAktionen schritte={angebote} recordId={v.id} />}
            {passiv.length > 0 && (
              <div className="actions" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
                {passiv.map((s) => (
                  <span key={s.code} className="badge neutral" title={s.art}>
                    {s.name} — wartet
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Details">
        <ActionForm action={vorgangKopfAendern.bind(null, v.id)}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 2, minWidth: 220 }}>
              <span>Titel</span>
              <input name="titel" maxLength={200} defaultValue={v.titel ?? ''} />
            </label>
            <label className="field" style={{ minWidth: 220 }}>
              <span>Kunde/Partner</span>
              <select name="partner_id" defaultValue={v.partner_id ?? ''}>
                <option value="">— auswählen —</option>
                {partner.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>
          {felder.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              {felder.map((f) => (
                <FeldEingabe key={f.name} feld={f} />
              ))}
            </div>
          )}
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="primary small" type="submit">Speichern</button>
            <span className="muted small">
              Änderungen hier bewegen den Ablauf nicht — sie pflegen seine Daten.
            </span>
          </div>
        </ActionForm>
        {verwaist.length > 0 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Ohne Felddefinition (Feld wurde entfernt):{' '}
            {verwaist.map(([name, wert]) => `${name} = ${String(wert)}`).join(' · ')}
          </p>
        )}
      </Card>

      <RecordComments model="vorgang" recordId={v.id} path={`/vorgaenge/${v.id}`} />

      {/* Der Ablaufplan ist Kontext, nicht Inhalt: eingeklappt am Ende statt
          560 px am Anfang. Wer wissen will, wo der Vorgang steht, sieht es
          schon am Zustands-Badge — das Diagramm ist einen Klick entfernt. */}
      <details style={{ marginTop: 4 }}>
        <summary className="muted" style={{ cursor: 'pointer', padding: '6px 0' }}>
          Ablauf anzeigen — aktueller Stand: {zustandsSchritt?.name ?? v.state}
        </summary>
        <ProzessPanel
          prozessCode={v.prozess_code}
          recordId={v.id}
          rolle={user.role}
          befugnisse={user.befugnisse}
          nurDiagramm
        />
      </details>
    </>
  )
}
