/**
 * ⋯-Menü (Entscheidungslog 2026-10-18, UX-Audit M5): seltene und
 * zerstörende Aktionen (Sperren, Stornieren, Zurücksetzen) liegen hier statt
 * als rote Knöpfe neben dem nächsten Schritt. Natives <details> — öffnet
 * vor der Hydration und ohne Client-JavaScript; die Einträge sind normale
 * Knöpfe/Links (ActionButton, Link), `mehr-menue-eintrag` und `gefahr`
 * stylen sie.
 */
export function MehrMenue({
  children,
  label = 'Weitere Aktionen',
}: {
  children: React.ReactNode
  label?: string
}) {
  return (
    <details className="mehr-menue">
      <summary className="btn" aria-label={label} title={label}>
        ⋯
      </summary>
      <div className="mehr-menue-liste">{children}</div>
    </details>
  )
}
