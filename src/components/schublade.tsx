/**
 * Schublade (Entscheidungslog 2026-10-18, UX-Audit M4): das Anlegeformular
 * einer Liste fährt von rechts heraus, statt über der Liste zu stehen — die
 * Liste beginnt direkt unter dem Seitenkopf. Der Knopf „+ Neu …" sitzt im
 * Kopf. Natives popover-Attribut wie beim Fehler-Panel: öffnet vor der
 * Hydration, schließt mit Esc oder Klick daneben; Auswahlfelder darin
 * öffnen ihre Liste als verschachteltes Popover.
 */
export function Schublade({
  id,
  knopf,
  titel,
  children,
}: {
  /** Eindeutige DOM-ID des Panels (z. B. "neu-auftrag"). */
  id: string
  /** Beschriftung des Kopf-Knopfs, z. B. „+ Neuer Fertigungsauftrag". */
  knopf: string
  titel: string
  children: React.ReactNode
}) {
  return (
    <>
      <button type="button" className="primary" popoverTarget={id}>
        {knopf}
      </button>
      <div id={id} popover="auto" className="ticket-panel schublade" role="dialog" aria-label={titel}>
        <div className="ticket-panel-head">
          <span>{titel}</span>
          <button type="button" className="small" popoverTarget={id} popoverTargetAction="hide" aria-label="Schließen">
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  )
}
