import Link from 'next/link'
import { SEITE_GROESSE, SEITE_GROESSEN, type Seite, groesseHref, seitenHref, seitenParameter, seitenText, seitenZahlen } from '@/modules/shared/seiten'

/**
 * Seitenleiste unter einer Liste (F3, seit 2026-10-18 mit Seitenzahlen und
 * Auswahl „Anzeigen 10 · 25 · 100"): links Anzahl und Größe, rechts
 * Blättern. Filter in `params` bleiben beim Blättern und Umschalten. Passt
 * alles auf eine Seite, bleibt nur die Größenwahl — und auch die erst ab
 * mehr als 10 Einträgen.
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
  if (gesamt <= SEITE_GROESSEN[0] && seite.seite === 1) return null
  const text = seitenText(seite, gesamt) ?? `${gesamt.toLocaleString('de-DE')} Einträge`
  const letzte = Math.max(1, Math.ceil(gesamt / seite.groesse))
  return (
    <nav className="seiten" aria-label="Seiten">
      <span className="seiten-info">
        <span className="small">{text}</span>
        <span className="seiten-groesse small" role="group" aria-label="Einträge je Seite">
          Anzeigen
          {SEITE_GROESSEN.map((g) =>
            g === seite.groesse ? (
              <span key={g} className="btn small" aria-current="true">{g}</span>
            ) : (
              <Link key={g} className="btn small" href={groesseHref(pfad, params, g)}>{g}</Link>
            ),
          )}
        </span>
      </span>
      {letzte > 1 && (
        <span className="seiten-blaettern">
          {seite.seite > 1 ? (
            <Link className="btn small" href={seitenHref(pfad, params, seite.seite - 1)} aria-label="Vorherige Seite">‹</Link>
          ) : (
            <span className="btn small disabled" aria-hidden="true">‹</span>
          )}
          {seitenZahlen(seite.seite, letzte).map((n, i) =>
            n === '…' ? (
              <span key={`l${i}`} className="seiten-luecke" aria-hidden="true">…</span>
            ) : n === seite.seite ? (
              <span key={n} className="btn small" aria-current="page">{n}</span>
            ) : (
              <Link key={n} className="btn small" href={seitenHref(pfad, params, n)} aria-label={`Seite ${n}`}>{n}</Link>
            ),
          )}
          {seite.seite < letzte ? (
            <Link className="btn small" href={seitenHref(pfad, params, seite.seite + 1)} aria-label="Nächste Seite">›</Link>
          ) : (
            <span className="btn small disabled" aria-hidden="true">›</span>
          )}
        </span>
      )}
    </nav>
  )
}

/**
 * Für GET-Suchformulare über einer Liste: trägt die gewählte Seitengröße
 * mit, damit eine Suche nicht auf 25 zurückspringt.
 */
export function GroesseBehalten({ params }: { params: { pro?: string | string[] } }) {
  const { groesse } = seitenParameter(params)
  return groesse === SEITE_GROESSE ? null : <input type="hidden" name="pro" value={groesse} />
}
