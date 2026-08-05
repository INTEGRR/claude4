'use client'
import { useState, useTransition } from 'react'

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
  action: () => Promise<void>
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
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen')
      }
    })
  }

  return (
    <>
      <button type="button" className={className} onClick={run} disabled={disabled || pending} title={title}>
        {pending ? '…' : children}
      </button>
      {error && (
        <span className="badge danger" role="alert" style={{ whiteSpace: 'normal', maxWidth: 460 }}>
          {error}
        </span>
      )}
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
  action: (formData: FormData) => Promise<void>
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
        await action(data)
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
      {error && (
        <div className="notice danger" style={{ marginTop: 8, marginBottom: 0 }} role="alert">
          {error}
        </div>
      )}
    </form>
  )
}
