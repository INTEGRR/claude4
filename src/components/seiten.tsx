import Link from 'next/link'
import { type Seite, seitenHref, seitenText } from '@/modules/shared/seiten'

/**
 * Seitenleiste unter einer Liste (F3): „1–50 von 318 ‹ ›". Verschwindet,
 * wenn alles auf eine Seite passt. Filter in `params` bleiben beim Blättern.
 */
export function Seiten({
  pfad,
  params,
  seite,
  gesamt,
}: {
  pfad: string
  params: Record<string, string | string[] | undefined>
  seite: Seite
  gesamt: number
}) {
  const text = seitenText(seite, gesamt)
  if (!text) return null
  const letzte = Math.max(1, Math.ceil(gesamt / seite.groesse))
  return (
    <nav className="seiten" aria-label="Seiten">
      <span className="mono small">{text}</span>
      {seite.seite > 1 ? (
        <Link className="btn small" href={seitenHref(pfad, params, seite.seite - 1)} aria-label="Vorherige Seite">‹</Link>
      ) : (
        <span className="btn small disabled" aria-hidden="true">‹</span>
      )}
      {seite.seite < letzte ? (
        <Link className="btn small" href={seitenHref(pfad, params, seite.seite + 1)} aria-label="Nächste Seite">›</Link>
      ) : (
        <span className="btn small disabled" aria-hidden="true">›</span>
      )}
    </nav>
  )
}
