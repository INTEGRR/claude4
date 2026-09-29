'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { ActionResult } from '@/modules/shared/action'

interface Platz {
  id: string
  name: string
  art: string
}

const ART_LABELS: Record<string, string> = {
  versand: 'Versand',
  fertigung: 'Fertigung',
  lager: 'Lager',
  sonstiges: 'Sonstiges',
}

/**
 * Arbeitsplatz dieses PCs im Kopf: zeigt, wo gedruckt wird, und schaltet um.
 * Bewusst ein natives Auswahlfeld mit onChange + startTransition — kein
 * <form action> in der Kopfzeile (Hydrationsfehler #418, siehe abmelden.tsx).
 */
export function ArbeitsplatzWaehler({
  plaetze,
  aktuell,
  action,
}: {
  plaetze: Platz[]
  aktuell: string | null
  action: (id: string | null) => Promise<ActionResult>
}) {
  const [pending, startTransition] = useTransition()
  const [fehler, setFehler] = useState<string | null>(null)
  const router = useRouter()
  const gewaehlt = plaetze.find((p) => p.id === aktuell) ?? null
  const arten = [...new Set(plaetze.map((p) => p.art))]

  return (
    <label
      className={`arbeitsplatz-waehler${gewaehlt ? '' : ' offen'}`}
      title={
        fehler ??
        (gewaehlt
          ? `Dieser PC gehört zu „${gewaehlt.name}" — gedruckt wird auf dessen Druckern`
          : 'Dieser PC hat keinen Arbeitsplatz — gedruckt wird auf den Ersatzdruckern')
      }
    >
      <span className={`led ${gewaehlt ? 'ok' : 'warn'}`} />
      <select
        aria-label="Arbeitsplatz dieses PCs"
        value={gewaehlt?.id ?? ''}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value || null
          startTransition(async () => {
            const r = await action(id)
            setFehler(r && 'error' in r ? r.error : null)
            router.refresh()
          })
        }}
      >
        <option value="">Arbeitsplatz wählen …</option>
        {arten.map((art) => (
          <optgroup key={art} label={ART_LABELS[art] ?? art}>
            {plaetze
              .filter((p) => p.art === art)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
