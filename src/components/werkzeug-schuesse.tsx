import { lebensdauer } from '@/modules/einkauf/werkzeuge'

/**
 * Schuss-Zähler eines Werkzeugs (0107) mit Balken der Lebensdauer — ab 90 %
 * im Akzent, ab 100 % rot. Gleiche Darstellung in Liste, Akte und Projekt.
 */
export function WerkzeugSchuesse({ zaehler, lebensdauerSchuss }: { zaehler: number; lebensdauerSchuss: number | null }) {
  const ld = lebensdauer(zaehler, lebensdauerSchuss)
  return (
    <span className="nowrap">
      {ld.pct !== null && (
        <span className={`lebensdauer ${ld.stufe}`} title={`${ld.pct} % der Lebensdauer`} style={{ marginRight: 6 }}>
          <span style={{ width: `${Math.min(ld.pct, 100)}%` }} />
        </span>
      )}
      <span className="mono small">
        {zaehler.toLocaleString('de-DE')}
        {lebensdauerSchuss ? ` / ${lebensdauerSchuss.toLocaleString('de-DE')}` : ''}
      </span>
    </span>
  )
}
