'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

interface Eintrag {
  id: string
  at: string
  kind: string
  titel: string
  details: string[]
}

const zeit = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * Debug-Box des Shopify-Probelaufs (0102): unten rechts auf jeder Seite, nur
 * für Admins und nur im Modus „Probelauf". Zeigt live, was KRNL an Shopify
 * geschickt HÄTTE — nichts davon wurde gesendet. Fragt alle 3 Sekunden nach.
 */
export function ShopifyProbeBox() {
  const [offen, setOffen] = useState(true)
  const [eintraege, setEintraege] = useState<Eintrag[]>([])
  const [ansteht, setAnsteht] = useState(false)
  const [neu, setNeu] = useState(0)
  const [laeuft, setLaeuft] = useState(false)
  const [geleert, setGeleert] = useState<string | null>(null)
  const bekannt = useRef(new Set<string>())

  const laden = useCallback(async () => {
    try {
      const url = geleert ? `/api/shopify/probe?seit=${encodeURIComponent(geleert)}` : '/api/shopify/probe'
      const r = await fetch(url, { cache: 'no-store' })
      if (!r.ok) return
      const d = (await r.json()) as { ansteht: boolean; eintraege: Eintrag[] }
      const frisch = d.eintraege.filter((e) => !bekannt.current.has(e.id))
      for (const e of d.eintraege) bekannt.current.add(e.id)
      if (frisch.length && bekannt.current.size > frisch.length) setNeu((n) => n + frisch.length)
      setEintraege(d.eintraege)
      setAnsteht(d.ansteht)
    } catch {
      // still — nächster Versuch in 3 Sekunden
    }
  }, [geleert])

  useEffect(() => {
    void laden()
    const t = setInterval(laden, 3000)
    return () => clearInterval(t)
  }, [laden])

  const jetzt = async () => {
    setLaeuft(true)
    try {
      await fetch('/api/shopify/probe', { method: 'POST' })
      await laden()
    } finally {
      setLaeuft(false)
    }
  }

  return (
    <aside className={`probe-box${offen ? ' offen' : ''}`} aria-label="Shopify-Probelauf">
      <button type="button" className="probe-kopf" onClick={() => { setOffen(!offen); setNeu(0) }}>
        <span className="led warn" /> Shopify-Probelauf — würde senden
        {neu > 0 && !offen ? <span className="probe-neu">{neu}</span> : null}
        <span className="muted">{offen ? '▾' : '▸'}</span>
      </button>
      {offen && (
        <div className="probe-inhalt">
          <div className="probe-leiste small">
            <span className="muted">
              {ansteht ? 'KRNL rechnet gleich neu …' : 'alles berechnet'} · an Shopify geht nichts raus
            </span>
            <span className="actions">
              <button
                type="button"
                className="small"
                onClick={jetzt}
                disabled={laeuft}
                title="Rechnet sofort in KRNL neu, was an Shopify gemeldet würde — sendet nichts"
              >
                {laeuft ? 'rechnet …' : 'Jetzt neu berechnen'}
              </button>
              <button
                type="button"
                className="small"
                onClick={() => { setGeleert(new Date().toISOString()); setEintraege([]); setNeu(0) }}
              >
                Leeren
              </button>
            </span>
          </div>
          {eintraege.length === 0 ? (
            <p className="small muted" style={{ margin: '8px 0' }}>
              Noch nichts. Arbeite normal in KRNL — was an Shopify ginge, erscheint hier.
            </p>
          ) : (
            <ol className="probe-liste">
              {eintraege.map((e) => (
                <li key={e.id}>
                  <div className="small">
                    <span className="mono muted">{zeit(e.at)}</span> <strong>{e.titel}</strong>
                  </div>
                  {e.details.length > 0 && (
                    <details>
                      <summary className="small muted">{e.details.length} Zeile(n)</summary>
                      <ul className="small mono">
                        {e.details.slice(0, 60).map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                        {e.details.length > 60 && <li>… und {e.details.length - 60} weitere</li>}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </aside>
  )
}
