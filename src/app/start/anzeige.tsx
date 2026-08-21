/**
 * Bausteine der Startseite, die Server- und Client-Teile gemeinsam nutzen.
 * Bewusst ohne 'use client' — so lassen sie sich in beiden Welten einsetzen.
 */

/**
 * Siebensegment-Anzeige mit Geister-Achten dahinter (Technik aus dem
 * Design-Handoff, identisch zum Boot-Splash). NUR für echte Zahlen — nie
 * für Dekoration.
 */
export function Seg({
  wert,
  farbe = 'signal',
  stellen,
}: {
  wert: number | string
  farbe?: 'signal' | 'kernel' | 'neutral'
  stellen?: number
}) {
  const text = String(wert)
  return (
    <span className={`seg ${farbe}`}>
      <span className="seg-geist" aria-hidden>
        {'8'.repeat(Math.max(text.length, stellen ?? 1))}
      </span>
      <span className="seg-wert">{text}</span>
    </span>
  )
}

/**
 * Abschnittsmarke im Stil des Handoffs („// Prozess First"). Der Text kommt
 * bewusst als Ausdruck statt als JSX-Text: zwei Schrägstriche am Anfang
 * eines JSX-Kindes liest sowohl der Linter als auch ein Mensch als
 * versehentlichen Kommentar.
 */
export function Eyebrow({ text }: { text: string }) {
  return <p className="eyebrow">{`// ${text}`}</p>
}
