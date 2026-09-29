'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Eine Zelle der Druckweg-Matrix: Auswahl ändern = Weg setzen (leer =
 * entfernen). onChange + startTransition statt Formular je Zelle — die
 * Matrix bleibt so eine ruhige Tabelle ohne Knopfreihe.
 */
export function DruckwegWahl({
  wert,
  drucker,
  leer,
  action,
}: {
  wert: string | null
  drucker: { id: string; label: string; passend: boolean }[]
  /** Anzeige ohne Weg — „Ersatz" bzw. „Browser". */
  leer: string
  action: (druckerId: string | null) => Promise<ActionResult>
}) {
  const [pending, startTransition] = useTransition()
  const [fehler, setFehler] = useState<string | null>(null)
  const router = useRouter()
  const passend = drucker.filter((d) => d.passend)
  const andere = drucker.filter((d) => !d.passend)

  return (
    <select
      className={`druckweg-wahl${wert ? ' gesetzt' : ''}`}
      value={wert ?? ''}
      disabled={pending}
      title={fehler ?? undefined}
      aria-invalid={fehler ? true : undefined}
      onChange={(e) => {
        const id = e.target.value || null
        startTransition(async () => {
          const r = await action(id)
          setFehler(r && 'error' in r ? r.error : null)
          router.refresh()
        })
      }}
    >
      <option value="">{leer}</option>
      {passend.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
      {andere.length > 0 && (
        <optgroup label="anderer Typ">
          {andere.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
