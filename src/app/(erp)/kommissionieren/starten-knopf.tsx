'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { isActionError, isActionInfo } from '@/modules/shared/action'
import { sammelnStarten } from './actions'

/**
 * Beansprucht eine Lieferung zum Sammeln (lager.kommissionierung_starten)
 * und öffnet direkt den Sammel-Screen — hält sie gerade jemand anderes,
 * steht der Name in der Fehlermeldung.
 */
export function StartenKnopf({
  pickingId,
  children,
  className,
}: {
  pickingId: string
  children: React.ReactNode
  className?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fehler, setFehler] = useState<string | null>(null)

  function los() {
    setFehler(null)
    startTransition(async () => {
      const r = await sammelnStarten(pickingId)
      if (isActionError(r)) {
        setFehler(r.error)
        return
      }
      const ziel = isActionInfo(r) && r.link ? r.link : `/kommissionieren/${pickingId}`
      router.push(ziel)
      router.refresh()
    })
  }

  return (
    <>
      <button type="button" className={className} onClick={los} disabled={pending}>
        {pending && <span className="led" style={{ background: 'currentColor' }} />}
        {children}
      </button>
      {fehler && (
        <div className="notice danger" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="led warn" style={{ marginRight: 6 }} />
          {fehler}
        </div>
      )}
    </>
  )
}
