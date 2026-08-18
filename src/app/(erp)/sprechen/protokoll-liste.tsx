import { Card, Empty } from '@/components/ui'

/**
 * Historie vergangener Sprachsitzungen — kompakt, das Volltranskript liegt
 * je Sitzung dahinter (/sprechen/[id] kommt in einer späteren Ausbaustufe;
 * bis dahin zeigen die Zähler, was passiert ist).
 */
export function ProtokollListe({
  sitzungen,
}: {
  sitzungen: {
    id: string
    begonnen_am: string
    beendet_am: string | null
    eintraege: number
    gebucht: number
  }[]
}) {
  return (
    <Card title="Vergangene Sitzungen">
      {sitzungen.length === 0 ? (
        <Empty>Noch keine abgeschlossenen Sprachsitzungen.</Empty>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sitzungen.map((s) => {
            const start = new Date(s.begonnen_am)
            const dauer =
              s.beendet_am != null
                ? Math.max(1, Math.round((+new Date(s.beendet_am) - +start) / 60000))
                : null
            return (
              <li
                key={s.id}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span className="mono muted">
                  {start.toLocaleString('de-DE', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="muted small">
                  {dauer != null ? `${dauer} min` : 'ohne Ende'} · {s.eintraege} Einträge
                </span>
                {s.gebucht > 0 && (
                  <span className="small">
                    <span className="led ok" style={{ marginRight: 4 }} />
                    {s.gebucht} gebucht
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
