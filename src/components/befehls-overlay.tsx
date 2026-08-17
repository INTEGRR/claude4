'use client'
import { useEffect, useRef } from 'react'
import {
  type BefehlsAktion,
  type BefehlsSeite,
  Befehlsfeld,
} from './befehlsfeld'

/**
 * Das Befehlsfeld überall: Strg/Cmd+K (oder der Knopf in der Kopfleiste)
 * öffnet dasselbe Feld wie auf der Übersicht als Overlay — Aktion, Beleg
 * oder Frage, ohne erst zur Startseite zu wechseln.
 */
export function BefehlsOverlay({
  aktionen,
  seiten,
  gewichte,
}: {
  aktionen: BefehlsAktion[]
  seiten: BefehlsSeite[]
  gewichte: Record<string, number>
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (dialog.current?.open) dialog.current.close()
        else dialog.current?.showModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        className="small befehls-knopf"
        title="Befehlsfeld öffnen (Strg+K)"
        onClick={() => dialog.current?.showModal()}
      >
        <span className="mono">⌘K</span>
      </button>
      <dialog
        ref={dialog}
        className="befehls-dialog"
        onClick={(e) => {
          // Klick auf den Backdrop (= das dialog-Element selbst) schließt.
          if (e.target === dialog.current) dialog.current?.close()
        }}
      >
        <Befehlsfeld
          aktionen={aktionen}
          seiten={seiten}
          gewichte={gewichte}
          gross
          autoFokus
          onNavigiert={() => dialog.current?.close()}
        />
      </dialog>
    </>
  )
}
