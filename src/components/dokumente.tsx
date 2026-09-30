import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { Card, Empty } from '@/components/ui'
import { DOKUMENT_ARTEN, type DokumentModell } from '@/modules/einkauf/dokument-modelle'
import { driveKonfiguriert } from '@/modules/google/auth'
import { driveLink } from '@/modules/google/drive'
import { dateTime } from '@/modules/shared/format'
import { DokumentUpload, DokumentZeilenKnoepfe } from './dokument-upload'

/**
 * Baustein „Dokumente" (0092): die Dateien eines Belegs aus der geteilten
 * Google-Ablage — Liste mit Art, Revision, Größe, Upload per Auswahl oder
 * Ablegen. Gleiche Karte an Bestellung, Rechnung, Artikel und Lieferant.
 */

export function groesseText(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function DokumenteKarte({
  modell,
  recordId,
  titel = 'Dokumente',
}: {
  modell: DokumentModell
  recordId: string
  titel?: string
}) {
  const dokumente = await sql<
    {
      id: string
      drive_file_id: string
      name: string
      art: keyof typeof DOKUMENT_ARTEN
      revision: string | null
      groesse: number | null
      quelle: string
      notiz: string | null
      hochgeladen_von: string | null
      created_at: string
    }[]
  >`
    select d.id, d.drive_file_id, d.name, d.art::text as art, d.revision, d.groesse::float as groesse,
           d.quelle::text as quelle, d.notiz, d.hochgeladen_von, d.created_at::text as created_at
    from dokument_verweise v
    join dokumente d on d.id = v.dokument_id
    where v.modell = ${modell} and v.record_id = ${recordId}
    order by d.created_at desc`
  const bereit = driveKonfiguriert()
  const user = await currentUser()
  const darf = Boolean(user && canWrite(user.role, 'einkauf', user.befugnisse))

  return (
    <Card title={`${titel} (${dokumente.length})`} tight>
      {!darf ? null : bereit ? (
        <DokumentUpload modell={modell} recordId={recordId} />
      ) : (
        <div className="notice" style={{ margin: 12 }}>
          Die Google-Ablage ist nicht angebunden — Dateien lassen sich erst nach der Einrichtung
          ablegen (Einstellungen → Schnittstellen → Google).
        </div>
      )}
      {dokumente.length === 0 ? (
        <Empty>Noch keine Dateien.</Empty>
      ) : (
        <ul className="dok-liste">
          {dokumente.map((d) => (
            <li key={d.id} className="dok-zeile">
              <div className="dok-text">
                <a href={driveLink(d.drive_file_id)} target="_blank" rel="noopener" className="dok-name">
                  {d.name}
                </a>
                <div className="muted small">
                  <span className="mono-label">{DOKUMENT_ARTEN[d.art] ?? d.art}</span>
                  {d.revision ? <> · Rev. {d.revision}</> : null} · {groesseText(d.groesse)} ·{' '}
                  {d.hochgeladen_von ?? d.quelle} · {dateTime(d.created_at)}
                </div>
                {d.notiz && <div className="small">{d.notiz}</div>}
              </div>
              {darf && (
                <DokumentZeilenKnoepfe
                  dokumentId={d.id}
                  art={d.art}
                  revision={d.revision}
                  modell={modell}
                  recordId={recordId}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
