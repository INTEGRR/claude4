import { sql } from '@/db/client'
import { addComment, type KommentarModell } from '@/app/(erp)/comments-action'
import { ActionForm } from '@/components/action-button'
import { AuditLog, Card, type LogEntry } from '@/components/ui'

/**
 * Verlauf + Kommentarfeld für einen beliebigen Datensatz. Ersetzt die
 * bisherigen "Verlauf"-Karten und bringt das Notizformular überall mit.
 */
export async function RecordComments({
  model,
  recordId,
  path,
  title = 'Verlauf & Kommentare',
}: {
  model: KommentarModell
  recordId: string
  /** Pfad der Detailseite — wird nach dem Speichern neu geladen. */
  path: string
  title?: string
}) {
  const log = await sql<LogEntry[]>`
    select id, kind, message, actor, created_at from audit_log
    where model = ${model} and record_id = ${recordId}
    order by created_at desc limit 60`

  return (
    <Card
      title={title}
      actions={<span className="mono-label">{log.length === 1 ? '1 Eintrag' : `${log.length} Einträge`}</span>}
    >
      <ActionForm action={addComment.bind(null, model, recordId, path)} style={{ marginBottom: 12 }}>
        <div className="row">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Kommentar</span>
            <input name="note" placeholder="Kommentar hinzufügen…" maxLength={2000} required />
          </label>
          <div className="shrink">
            <button type="submit">Speichern</button>
          </div>
        </div>
      </ActionForm>
      <AuditLog entries={log} />
    </Card>
  )
}
