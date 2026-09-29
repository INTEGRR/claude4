'use client'
import { createContext, useContext, useState, useTransition } from 'react'
import { isActionError, isActionInfo } from '@/modules/shared/action'
import { packzettelDrucken } from '../kommissionieren/actions'

/**
 * Auswahl in der Versand-Liste (0091): Zeilen anhaken, „Alle auswählen",
 * dann „Packzettel drucken (N)" — auf dem A4-Drucker des Arbeitsplatzes
 * (versand.packzettel_drucken), ohne Drucker als Sammeldruck im Browser.
 * Der Packzettel ist zugleich der Kommissionierbeleg für den Papierweg.
 */

interface Auswahl {
  alle: string[]
  gewaehlt: Set<string>
  umschalten: (id: string) => void
  setzen: (ids: string[]) => void
}

/** Grenze der Registry-Aktion (ein Druckauftrag je Lieferung). */
const MAX_JE_DRUCK = 100

const AuswahlKontext = createContext<Auswahl | null>(null)

export function AuswahlBereich({ ids, children }: { ids: string[]; children: React.ReactNode }) {
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set())
  const umschalten = (id: string) =>
    setGewaehlt((g) => {
      const n = new Set(g)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <AuswahlKontext.Provider value={{ alle: ids, gewaehlt, umschalten, setzen: (l) => setGewaehlt(new Set(l)) }}>
      {children}
    </AuswahlKontext.Provider>
  )
}

function useAuswahl(): Auswahl {
  const a = useContext(AuswahlKontext)
  if (!a) throw new Error('AuswahlBereich fehlt')
  return a
}

export function AuswahlBox({ id, label }: { id: string; label: string }) {
  const { gewaehlt, umschalten } = useAuswahl()
  return (
    <input
      type="checkbox"
      aria-label={`${label} auswählen`}
      checked={gewaehlt.has(id)}
      onChange={() => umschalten(id)}
    />
  )
}

export function AuswahlAlle() {
  const { alle, gewaehlt, setzen } = useAuswahl()
  const voll = alle.length > 0 && alle.every((id) => gewaehlt.has(id))
  return (
    <input
      type="checkbox"
      aria-label="Alle auswählen"
      checked={voll}
      onChange={() => setzen(voll ? [] : alle)}
    />
  )
}

export function PackzettelLeiste() {
  const { alle, gewaehlt, setzen } = useAuswahl()
  const [pending, startTransition] = useTransition()
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean; link?: string } | null>(null)
  const auswahl = alle.filter((id) => gewaehlt.has(id))

  function drucken() {
    setMeldung(null)
    startTransition(async () => {
      const r = await packzettelDrucken(auswahl)
      if (isActionError(r)) {
        setMeldung({ text: r.error, fehler: true })
        return
      }
      if (isActionInfo(r)) {
        // Ohne Drucker: Sammeldruck sofort im Tab; der Link darunter fängt
        // Popup-Blocker ab.
        if (r.link) window.open(r.link, '_blank', 'noopener')
        setMeldung({ text: r.info, fehler: false, link: r.link })
      }
      setzen([])
    })
  }

  return (
    <div className="row" style={{ alignItems: 'center', gap: 12, padding: '10px 12px 0' }}>
      <div className="shrink">
        <button
          type="button"
          onClick={drucken}
          disabled={pending || auswahl.length === 0 || auswahl.length > MAX_JE_DRUCK}
          title={auswahl.length > MAX_JE_DRUCK ? `Höchstens ${MAX_JE_DRUCK} je Druck` : undefined}
        >
          {pending && <span className="led" style={{ background: 'currentColor' }} />}
          Packzettel drucken ({auswahl.length})
        </button>
      </div>
      <div className="shrink">
        <button
          type="button"
          className="small"
          onClick={() => setzen(auswahl.length === alle.length ? [] : alle)}
          disabled={alle.length === 0}
        >
          {auswahl.length === alle.length && alle.length > 0 ? 'Auswahl aufheben' : 'Alle auswählen'}
        </button>
      </div>
      {meldung && (
        <div
          className={`notice ${meldung.fehler ? 'danger' : 'success'}`}
          role={meldung.fehler ? 'alert' : 'status'}
          style={{ marginBottom: 0 }}
        >
          {meldung.text}
          {meldung.link && (
            <>
              {' '}
              <a href={meldung.link} target="_blank" rel="noopener">
                Sammeldruck öffnen
              </a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
