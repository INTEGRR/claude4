import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { DokumenteKarte } from '@/components/dokumente'
import { WiedervorlagenKarte } from '@/components/mail-threads'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { BEWERTUNG_NOTEN, MUSTER_ERGEBNISSE, naechsteRevision, rundeText, trackingLink } from '@/modules/einkauf/bemusterung'
import { date, dateTime, money } from '@/modules/shared/format'
import { entwurfAnlegen } from '../../entwuerfe/actions'
import { musterAendern, musterBewerten, musterErhalten } from '../actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Eine Muster-Runde (Bemusterung, 0107): Daten, Eingang, Bewertung
 * (freigeben als Golden Sample, nachbessern lassen → nächste Runde,
 * ablehnen), Fotos und Prüfberichte als Dokumente, alle Runden mit diesem
 * Lieferanten, Feedback-Mail aus der Vorlage, Prozess und Verlauf.
 */
export default async function MusterRundePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const pfad = `/einkauf/muster/${id}`

  const [b] = await sql<
    {
      id: string
      runde: number
      revision: string | null
      bezeichnung: string | null
      menge: number | null
      kosten: number | null
      waehrung: string
      bestellt_am: string | null
      erhalten_am: string | null
      tracking: string | null
      status: string
      golden: boolean
      bewertung_note: number | null
      bewertung: string | null
      bewertet_von: string | null
      bewertet_am: string | null
      notiz: string | null
      vorgaenger_id: string | null
      erstellt_von: string | null
      projekt_id: string
      projekt_nummer: string
      projekt_titel: string
      muster_pflicht: boolean
      partner_id: string
      lieferant: string
      angebot_version: number | null
    }[]
  >`
    select b.id, b.runde, b.revision, b.bezeichnung, b.menge::float as menge, b.kosten::float as kosten, b.waehrung,
           b.bestellt_am::text as bestellt_am, b.erhalten_am::text as erhalten_am, b.tracking, b.status::text as status,
           b.golden, b.bewertung_note, b.bewertung, b.bewertet_von, b.bewertet_am::text as bewertet_am, b.notiz,
           b.vorgaenger_id, b.erstellt_von,
           ep.id as projekt_id, ep.nummer as projekt_nummer, ep.titel as projekt_titel, ep.muster_pflicht,
           pa.id as partner_id, pa.name as lieferant, a.version as angebot_version
    from bemusterungen b
    join einkaufsprojekte ep on ep.id = b.projekt_id
    join partners pa on pa.id = b.partner_id
    left join lieferantenangebote a on a.id = b.angebot_id
    where b.id = ${id}`
  if (!b) notFound()

  const runden = await sql<
    { id: string; runde: number; revision: string | null; bezeichnung: string | null; status: string; golden: boolean; erhalten_am: string | null; bewertung: string | null }[]
  >`
    select id, runde, revision, bezeichnung, status::text as status, golden, erhalten_am::text as erhalten_am, bewertung
    from bemusterungen where projekt_id = ${b.projekt_id} and partner_id = ${b.partner_id}
    order by runde`
  const nachfolger = runden.find((r) => r.runde === b.runde + 1 && b.status === 'nachbessern')
  const offen = b.status === 'offen'
  const link = trackingLink(b.tracking)
  const heute = new Date().toISOString().slice(0, 10)

  return (
    <>
      <PageHeader
        kicker="Muster"
        title={
          <>
            {rundeText(b)} · {b.lieferant}
          </>
        }
        subtitle={
          <>
            <Badge state={b.status} kind="bemusterung" />
            {b.golden && <span className="badge success" style={{ marginLeft: 4 }}>Golden Sample</span>}{' '}
            <Link href={`/einkauf/projekte/${b.projekt_id}`}>
              <span className="mono">{b.projekt_nummer}</span> {b.projekt_titel}
            </Link>
            {' · '}
            <Link href={`/einkauf/lieferanten/${b.partner_id}`}>{b.lieferant}</Link>
            {b.muster_pflicht ? ' · Projekt mit Musterpflicht' : ''}
          </>
        }
        actions={
          <Link className="btn" href="/einkauf/muster">
            Alle Muster
          </Link>
        }
      />

      {nachfolger && (
        <div className="notice warn">
          Zum Nachbessern zurück — weiter geht es in{' '}
          <Link href={`/einkauf/muster/${nachfolger.id}`}>{rundeText(nachfolger)}</Link>.
        </div>
      )}
      {b.golden && (
        <div className="notice info">
          Golden Sample: die Referenz für die Serie
          {b.muster_pflicht ? ` — ${b.projekt_nummer} darf bei ${b.lieferant} bestellt werden` : ''}.
        </div>
      )}

      <Card title="Runde">
        <dl className="kv">
          <dt>Bezeichnung</dt>
          <dd>{b.bezeichnung ?? '—'}</dd>
          <dt>Revision</dt>
          <dd>{b.revision ?? '—'}</dd>
          <dt>Menge</dt>
          <dd>{b.menge ?? '—'}</dd>
          <dt>Kosten</dt>
          <dd>{b.kosten !== null ? money(b.kosten, b.waehrung) : '—'}</dd>
          <dt>Angefordert</dt>
          <dd>
            {date(b.bestellt_am)}
            {b.erstellt_von ? ` · ${b.erstellt_von}` : ''}
            {b.angebot_version ? ` · zum Angebot v${b.angebot_version}` : ''}
          </dd>
          <dt>Eingang</dt>
          <dd>{b.erhalten_am ? date(b.erhalten_am) : 'noch unterwegs'}</dd>
          <dt>Tracking</dt>
          <dd className="mono">
            {link ? (
              <a href={link} target="_blank" rel="noreferrer">
                {b.tracking}
              </a>
            ) : (
              (b.tracking ?? '—')
            )}
          </dd>
          {b.vorgaenger_id && (
            <>
              <dt>Vorherige Runde</dt>
              <dd>
                <Link href={`/einkauf/muster/${b.vorgaenger_id}`}>Runde {b.runde - 1}</Link>
              </dd>
            </>
          )}
          {b.bewertet_am && (
            <>
              <dt>Bewertung</dt>
              <dd>
                {b.bewertung_note ? `${BEWERTUNG_NOTEN[b.bewertung_note as keyof typeof BEWERTUNG_NOTEN]} · ` : ''}
                {b.bewertet_von}, {dateTime(b.bewertet_am)}
                {b.bewertung && <div style={{ whiteSpace: 'pre-wrap' }}>{b.bewertung}</div>}
              </dd>
            </>
          )}
          {b.notiz && (
            <>
              <dt>Notiz</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{b.notiz}</dd>
            </>
          )}
        </dl>

        {darf && (
          <details style={{ marginTop: 10 }}>
            <summary className="small">Daten nachtragen</summary>
            <ActionForm action={musterAendern.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Bezeichnung</span>
                  <input name="bezeichnung" defaultValue={b.bezeichnung ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Revision</span>
                  <input name="revision" defaultValue={b.revision ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Menge</span>
                  <input name="menge" inputMode="decimal" defaultValue={b.menge ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Kosten</span>
                  <input name="kosten" inputMode="decimal" defaultValue={b.kosten ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Währung</span>
                  <input name="waehrung" className="mono" maxLength={3} defaultValue={b.waehrung} />
                </label>
              </div>
              <div className="row">
                <label className="field shrink">
                  <span>Angefordert am</span>
                  <input type="date" name="bestellt_am" defaultValue={b.bestellt_am ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Eingang am</span>
                  <input type="date" name="erhalten_am" defaultValue={b.erhalten_am ?? ''} />
                </label>
                <label className="field">
                  <span>Tracking</span>
                  <input name="tracking" className="mono" defaultValue={b.tracking ?? ''} />
                </label>
              </div>
              <label className="field">
                <span>Notiz</span>
                <textarea name="notiz" rows={2} defaultValue={b.notiz ?? ''} />
              </label>
              <button type="submit" className="small">Speichern</button>
            </ActionForm>
          </details>
        )}
      </Card>

      {darf && offen && (
        <Card title="Eingang und Bewertung">
          {!b.erhalten_am && (
            <ActionForm action={musterErhalten.bind(null, id)} style={{ marginBottom: 12 }}>
              <div className="row">
                <label className="field shrink">
                  <span>Eingegangen am</span>
                  <input type="date" name="erhalten_am" defaultValue={heute} />
                </label>
                <label className="field">
                  <span>Tracking (optional)</span>
                  <input name="tracking" className="mono" placeholder={b.tracking ?? ''} />
                </label>
                <div className="shrink field">
                  <button type="submit" className="small primary">Eingang erfassen</button>
                </div>
              </div>
            </ActionForm>
          )}
          <ActionForm action={musterBewerten.bind(null, id)}>
            <input type="hidden" name="golden_feld" value="1" />
            <div className="row">
              <label className="field shrink">
                <span>Ergebnis</span>
                <Auswahl name="ergebnis" defaultValue="freigeben">
                  {Object.entries(MUSTER_ERGEBNISSE).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Note</span>
                <Auswahl name="note" defaultValue="">
                  <option value="">—</option>
                  {Object.entries(BEWERTUNG_NOTEN)
                    .reverse()
                    .map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Nächste Revision (beim Nachbessern)</span>
                <input name="naechste_revision" placeholder={naechsteRevision(b.revision) ?? 'z. B. B'} />
              </label>
            </div>
            <label className="small" style={{ display: 'block', margin: '4px 0 8px' }}>
              <input type="checkbox" name="golden" defaultChecked /> Beim Freigeben als <strong>Golden Sample</strong>{' '}
              (Referenz für die Serie) markieren — ersetzt ein früheres dieses Lieferanten
            </label>
            <label className="field">
              <span>Befund (Pflicht beim Nachbessern und Ablehnen)</span>
              <textarea name="bewertung" rows={3} placeholder="z. B. Farbe zu hell, Einfallstellen an den Domen …" />
            </label>
            <button type="submit" className="small primary">Bewertung speichern</button>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Nachbessern legt sofort die nächste Runde an. Ohne erfassten Eingang gilt das Muster beim Freigeben oder
              Nachbessern als heute eingegangen.
            </p>
          </ActionForm>
        </Card>
      )}

      {darf && (
        <Card title="Rückmeldung an den Lieferanten">
          <ActionForm action={entwurfAnlegen}>
            <input type="hidden" name="partner_id" value={b.partner_id} />
            <input type="hidden" name="vorlage" value="muster_feedback" />
            <input type="hidden" name="einkaufsprojekt_id" value={b.projekt_id} />
            <button type="submit" className="small">Mail-Entwurf „Muster-Feedback"</button>
            <span className="small muted" style={{ marginLeft: 8 }}>
              in der Sprache des Lieferanten, mit Deutsch zum Mitlesen — Befund einfügen, gegenlesen, freigeben.
            </span>
          </ActionForm>
        </Card>
      )}

      <Card title={`Alle Runden mit ${b.lieferant} (${runden.length})`} tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Runde</th>
                <th>Eingang</th>
                <th>Befund</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runden.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/einkauf/muster/${r.id}`}>{rundeText(r)}</Link>
                  </td>
                  <td className="small nowrap">{r.erhalten_am ? date(r.erhalten_am) : '—'}</td>
                  <td className="small muted">{r.bewertung ?? '—'}</td>
                  <td className="nowrap">
                    <Badge state={r.status} kind="bemusterung" href={`/einkauf/muster/${r.id}`} />
                    {r.golden && <span className="badge success" style={{ marginLeft: 4 }}>Golden</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <DokumenteKarte modell="bemusterung" recordId={id} titel="Fotos und Prüfberichte" />
      <WiedervorlagenKarte modell="bemusterung" recordId={id} pfad={pfad} />
      <ProzessPanel prozessCode="bemusterung" recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} nurDiagramm />
      <RecordComments model="bemusterung" recordId={id} path={pfad} />
    </>
  )
}
