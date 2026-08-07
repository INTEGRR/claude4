'use client'
import { useState, useTransition } from 'react'
import { type ActionResult, isActionError } from '@/modules/shared/action'

/**
 * Fehlerzeile: Leuchte plus Wort, dann die Meldung im Klartext. Bewusst
 * `.notice` und kein `.badge` — Badges sind Typenschilder für kurze
 * Zustandswörter, keine Behälter für Fließtext.
 */
function ErrorNotice({ message, style }: { message: string; style?: React.CSSProperties }) {
  return (
    <div className="notice danger" role="alert" style={{ marginBottom: 0, maxWidth: 460, ...style }}>
      <span className="led warn" style={{ marginRight: 6 }} />
      <span className="mono-label" style={{ marginRight: 6, color: 'inherit' }}>
        Fehler
      </span>
      {message}
    </div>
  )
}

/**
 * Schaltfläche für Server Actions: zeigt Fehler aus der Fachlogik direkt an,
 * statt sie in einer Fehlerseite verschwinden zu lassen. Genau diese
 * Meldungen ("Erledigte Transfers können nicht storniert werden") sind für
 * die Bedienung wichtig.
 */
export function ActionButton({
  action,
  children,
  confirm,
  className,
  disabled,
  title,
}: {
  action: () => Promise<ActionResult>
  children: React.ReactNode
  confirm?: string
  className?: string
  disabled?: boolean
  title?: string
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run() {
    if (confirm && !window.confirm(confirm)) return
    setError(null)
    startTransition(async () => {
      try {
        // Fachliche Fehler kommen als Rückgabewert (Next.js schwärzt geworfene
        // Fehler im Produktionsbau), technische weiterhin als Ausnahme.
        const result = await action()
        if (isActionError(result)) setError(result.error)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen')
      }
    })
  }

  return (
    <>
      {/* Beschriftung bleibt stehen, die Leuchte zeigt den laufenden Vorgang —
          so springt die Knopfbreite nicht und der Zustand hat ein Zeichen.
          Die Leuchte trägt bewusst NICHT `.led.on`: auf der Primärtaste stünde
          dann der Akzent auf dem Akzent und der Punkt wäre unsichtbar. Mit
          `currentColor` nimmt sie die Schriftfarbe der jeweiligen Taste an —
          weiß auf Primär, --text auf neutral, --danger auf der roten. */}
      <button type="button" className={className} onClick={run} disabled={disabled || pending} title={title}>
        {pending && <span className="led" style={{ background: 'currentColor' }} />}
        {children}
      </button>
      {error && <ErrorNotice message={error} />}
    </>
  )
}

/** Formular mit Server Action inkl. sichtbarer Fehlermeldung. */
export function ActionForm({
  action,
  children,
  className,
  style,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    setError(null)
    startTransition(async () => {
      try {
        const result = await action(data)
        if (isActionError(result)) {
          setError(result.error)
          return                    // Eingaben stehen lassen, damit nichts verloren geht
        }
        form.reset()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen')
      }
    })
  }

  return (
    <form onSubmit={onSubmit} className={className} style={style}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {children}
      </fieldset>
      {error && <ErrorNotice message={error} style={{ marginTop: 8 }} />}
    </form>
  )
}
