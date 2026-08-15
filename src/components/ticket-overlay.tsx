'use client'
import { useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { ticketMelden } from '@/app/(erp)/tickets/actions'
import { isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Fehler melden, ohne die Arbeit zu verlassen: ein Reiter am rechten
 * Bildschirmrand fährt ein Panel aus, die Seite ist aus dem aktuellen Pfad
 * vorbelegt. Nach dem Absenden bleibt man, wo man war — das Ticket bestätigt
 * sich mit Nummer und Link im Panel.
 */
export function TicketOverlay() {
  const pathname = usePathname()
  const [offen, setOffen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [ergebnis, setErgebnis] = useState<
    { ok: boolean; text: string; link?: string } | null
  >(null)

  function absenden(form: HTMLFormElement) {
    const daten = new FormData(form)
    startTransition(async () => {
      try {
        const result = await ticketMelden(daten)
        if (isActionError(result)) {
          setErgebnis({ ok: false, text: result.error })
        } else if (isActionInfo(result)) {
          setErgebnis({ ok: true, text: result.info, link: result.link })
          form.reset()
        }
      } catch (err) {
        setErgebnis({
          ok: false,
          text: err instanceof Error ? err.message : 'Verbindungsfehler',
        })
      }
    })
  }

  return (
    <>
      <button
        type="button"
        className="ticket-tab"
        aria-expanded={offen}
        onClick={() => {
          setOffen((o) => !o)
          setErgebnis(null)
        }}
      >
        Fehler?
      </button>

      {offen && (
        <div className="ticket-panel" role="dialog" aria-label="Fehler melden">
          <div className="ticket-panel-head">
            <span>Fehler melden</span>
            <button type="button" className="small" onClick={() => setOffen(false)}>
              Schließen
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              absenden(e.currentTarget)
            }}
          >
            <label className="field">
              <span>Was geht schief? (kurz)</span>
              <input name="titel" required maxLength={200} autoFocus />
            </label>
            <div className="row">
              <label className="field">
                <span>Schwere</span>
                <select name="schwere" defaultValue="stoerend">
                  <option value="kritisch">kritisch — blockiert</option>
                  <option value="stoerend">störend — Umweg nötig</option>
                  <option value="kosmetisch">kosmetisch</option>
                </select>
              </label>
              <label className="field">
                <span>Seite</span>
                {/* Vorbelegt mit dem Ort des Geschehens — genau dafür ist das Overlay da. */}
                <input className="mono" name="seite" defaultValue={pathname ?? ''} key={pathname} />
              </label>
            </div>
            <label className="field">
              <span>Was ist passiert, was hast du erwartet?</span>
              <textarea name="beschreibung" rows={4} maxLength={4000} />
            </label>
            <button className="primary" type="submit" disabled={pending}>
              {pending && <span className="led" style={{ background: 'currentColor' }} />}
              Melden
            </button>
          </form>

          {ergebnis && (
            <div
              className={`notice ${ergebnis.ok ? 'success' : 'danger'}`}
              style={{ marginTop: 10, marginBottom: 0 }}
            >
              {ergebnis.text} {ergebnis.link && <a href={ergebnis.link}>Ticket öffnen</a>}
            </div>
          )}
        </div>
      )}
    </>
  )
}
