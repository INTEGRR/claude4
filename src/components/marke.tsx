/**
 * Die Marke „KRNL" — EINE Quelle für Splash, Sidebar, Anmeldeschirm und die
 * Icon-Erzeugung. Geometrie aus dem Design-Handoff (Hexcore auf 0–100):
 * Sechseck-Kontur, orangener Kern, zwei verrutschte Kanten (die
 * Glitch-Signatur), violette Speichen. Die Kontur läuft über currentColor
 * und folgt damit Hell/Dunkel; Signal-Orange und Kernel-Violett sind in
 * beiden Themes fix — Akzentdisziplin: Orange führt, Violett antwortet.
 *
 * Verkleinerungsleiter laut Brand-Kit: ab ~30 px fallen die Speichen und
 * Slips (Variante 'einfach', dickere Kontur), unter ~20 px wächst der Kern
 * (Variante 'klein').
 */

const SIGNAL = '#FF5A1F'
const KERNEL = '#7C5AFF'

export function HexcoreMark({
  groesse = 24,
  variante = 'voll',
  kontur = 'currentColor',
}: {
  groesse?: number
  variante?: 'voll' | 'einfach' | 'klein'
  kontur?: string
}) {
  return (
    <svg
      width={groesse}
      height={groesse}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden
      style={{ flex: 'none' }}
    >
      <path
        d="M50 6 L88 28 L88 72 L50 94 L12 72 L12 28 Z"
        stroke={kontur}
        strokeWidth={variante === 'voll' ? 6 : variante === 'einfach' ? 9 : 12}
      />
      {variante === 'voll' && (
        <>
          <path d="M50 6 L88 28" stroke={SIGNAL} strokeWidth="6" transform="translate(6,-3)" />
          <path d="M12 72 L50 94" stroke={KERNEL} strokeWidth="6" transform="translate(-5,3)" />
          <path
            d="M50 20 L50 42 M28 40 L42 50 M72 40 L58 50 M50 58 L50 78"
            stroke={KERNEL}
            strokeWidth="3"
          />
        </>
      )}
      {variante === 'klein' ? (
        <rect x="38" y="38" width="24" height="24" fill={SIGNAL} />
      ) : (
        <rect x="42" y="42" width="16" height="16" fill={SIGNAL} />
      )}
    </svg>
  )
}

/** Wortmarke: Geist 900, enge Laufweite — Beschriftung neben dem Zeichen. */
export function Wortmarke({ groesse = 17 }: { groesse?: number }) {
  return (
    <span
      style={{
        fontWeight: 900,
        fontSize: groesse,
        letterSpacing: '-0.05em',
        lineHeight: 1,
      }}
    >
      KRNL
    </span>
  )
}
