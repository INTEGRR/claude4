'use client'
import { KiChat } from '@/app/(erp)/ki/chat'

/**
 * Der KI-Chat als Slide-out von jeder Seite: ein Reiter unter dem
 * Fehler-Reiter fährt den Chat aus, ohne die Arbeit zu verlassen — das
 * Fenster darf offen bleiben, der Gesprächsstand überlebt das Schließen
 * (die Komponente bleibt gemountet, das Popover blendet nur aus).
 *
 * Öffnen/Schließen wie beim Fehler-Panel über das NATIVE popover-Attribut:
 * der erste Klick sitzt auch vor der Hydration.
 */
export function KiOverlay() {
  return (
    <>
      <button type="button" className="ticket-tab ki-tab" popoverTarget="ki-panel">
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
        <KiChat />
      </div>
    </>
  )
}
