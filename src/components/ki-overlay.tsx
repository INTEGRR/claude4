'use client'
import { KiChat } from '@/app/(erp)/ki/chat'

/**
 * Der KI-Chat als Slide-out von jeder Seite: ein Knopf in der Kopfleiste
 * (seit 2026-10-18, vorher ein Reiter am rechten Rand) fährt den Chat aus, ohne die Arbeit zu verlassen — das
 * Fenster darf offen bleiben, der Gesprächsstand überlebt das Schließen
 * (die Komponente bleibt gemountet, das Popover blendet nur aus).
 *
 * Öffnen/Schließen wie beim Fehler-Panel über das NATIVE popover-Attribut:
 * der erste Klick sitzt auch vor der Hydration.
 */
export function KiOverlay({ sprechen }: { sprechen?: boolean }) {
  return (
    <>
      <button type="button" className="small ticket-tab ki-knopf" popoverTarget="ki-panel" aria-label="KI-Assistent öffnen">
        KI
      </button>

      <div
        id="ki-panel"
        popover="auto"
        className="ticket-panel ki-overlay"
        role="dialog"
        aria-label="KI-Analyse"
      >
        <div className="ticket-panel-head">
          <span>KI-Analyse</span>
          <span className="actions" style={{ gap: 8 }}>
            <a className="btn small" href="/ki">
              Als Seite öffnen
            </a>
            <button
              type="button"
              className="small"
              popoverTarget="ki-panel"
              popoverTargetAction="hide"
            >
              Schließen
            </button>
          </span>
        </div>
        <KiChat sprechen={sprechen} />
      </div>
    </>
  )
}
