import { sql } from '@/db/client'
import { type LabelArt, label } from '@/modules/shared/format'
import { type LeistenSchritt, type Stufe, leiste, mitFolgestufen } from '@/modules/prozesse/statusleiste'

/**
 * Statusleiste im Kopf einer Belegseite (Entscheidungslog 2026-10-18,
 * UX-Audit M1): die Stufen aus der aktiven Prozessversion, der aktuelle
 * Belegstatus hervorgehoben. Beschriftung aus der Zustandstabelle (LABELS),
 * sonst der Schrittname. `children` steht rechts daneben — dort sitzt der
 * empfohlene nächste Schritt.
 */
export async function Statusleiste({
  prozessCode,
  art,
  zustand,
  hinweis,
  danach = [],
  children,
}: {
  prozessCode: string
  /** Belegart der Zustandstabelle für die Beschriftung. */
  art?: LabelArt
  /** Der aktuelle Belegstatus. */
  zustand: string | null
  /** Ein Satz unter der Leiste: was gerade wartet. */
  hinweis?: React.ReactNode
  /** Folgestufen ohne eigenen Belegzustand (z. B. Geliefert, Berechnet), Stand von der Seite. */
  danach?: { name: string; stand: Stufe['stand'] }[]
  children?: React.ReactNode
}) {
  const schritte = await sql<LeistenSchritt[]>`
    select s.code, s.name, s.art::text as art, s.optional, s.zustand, s.sequence,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o on o.prozess_code = ${prozessCode} and o.schritt_code = s.code
    where s.version_id = prozess_aktive_version(${prozessCode})`
  const l = mitFolgestufen(leiste(schritte, zustand), danach)
  if (l.stufen.length === 0 && !children && !hinweis) return null
  const name = (z: string, schritt: string) => {
    if (!art) return schritt
    const text = label(art, z)
    return text === z ? schritt : text
  }

  return (
    <section className="statusleiste" aria-label="Stand des Belegs">
      <div className="statusleiste-kopf">
        {l.stufen.length > 0 && (
        <ol className="statusleiste-stufen" style={{ gridTemplateColumns: `repeat(${l.stufen.length}, minmax(0, 1fr))` }}>
          {l.stufen.map((s) => (
            <li key={s.zustand} className={`stufe ${s.stand}`} aria-current={s.stand === 'aktuell' ? 'step' : undefined}>
              <span className="stufe-balken" aria-hidden />
              <span className="stufe-name">{name(s.zustand, s.schritt)}</span>
            </li>
          ))}
        </ol>
        )}
        {children && <div className="statusleiste-aktionen">{children}</div>}
      </div>
      {l.abseits && art && (
        <p className="statusleiste-hinweis abseits">
          Steht auf <strong>{label(art, l.abseits)}</strong> — außerhalb des regulären Ablaufs.
        </p>
      )}
      {hinweis && <p className="statusleiste-hinweis">{hinweis}</p>}
    </section>
  )
}
