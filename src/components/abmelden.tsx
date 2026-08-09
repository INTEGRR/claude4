'use client'
import { useTransition } from 'react'

/**
 * Abmelden ohne <form action={…}>.
 *
 * Der Grund ist unangenehm konkret: für Server-Action-Formulare rendert der
 * Server Fallback-Attribute (method, enctype, verstecktes $ACTION_ID-Feld),
 * die der Client nicht rendert. Je nach Hydrations-Timing wertet React das
 * als Baum-Abweichung und baut die Seite mit Fehler #418 neu auf — in der
 * Produktion in etwa jedem zweiten frischen Seitenaufruf, quer durch alle
 * Seiten, weil die Seitenleiste überall hängt. Der Aufruf über onClick und
 * startTransition umgeht die Fallback-Attribute vollständig; die Weiterleitung
 * aus der Action funktioniert unverändert.
 */
export function AbmeldenKnopf({ action }: { action: () => Promise<void> }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      className="small"
      type="button"
      disabled={pending}
      style={{ width: '100%', justifyContent: 'center' }}
      onClick={() => startTransition(async () => action())}
    >
      Abmelden
    </button>
  )
}
