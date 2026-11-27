'use client'
import { useEffect, useRef, useState } from 'react'
import type { MontageKnoten } from '@/modules/fertigung/montage-logik'
import type { MontageStand } from '@/modules/fertigung/montage'

/**
 * Montage-Übersicht (0141): das Brett für die Werkbank. Fragt alle vier
 * Sekunden den Stand ab; Zahlen laufen auf den neuen Wert, Balken wachsen,
 * was sich geändert hat, leuchtet kurz auf. Wer weniger Bewegung will
 * (Systemeinstellung), bekommt die Werte ohne Lauf.
 */

const TAKT_MS = 4000

/** Zahl, die auf ihren neuen Wert läuft. */
export function Zahl({ wert }: { wert: number }) {
  const [anzeige, setAnzeige] = useState(wert)
  const von = useRef(wert)
  useEffect(() => {
    const start = von.current
    if (start === wert) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      von.current = wert
      setAnzeige(wert)
      return
    }
    const t0 = performance.now()
    const dauer = 650
    let bild = 0
    const schritt = (t: number) => {
      const p = Math.min(1, (t - t0) / dauer)
      const sanft = 1 - (1 - p) ** 3
      const jetzt = Math.round(start + (wert - start) * sanft)
      von.current = jetzt
      setAnzeige(jetzt)
      if (p < 1) bild = requestAnimationFrame(schritt)
    }
    bild = requestAnimationFrame(schritt)
    return () => cancelAnimationFrame(bild)
  }, [wert])
  return <span className="montage-zahl">{anzeige.toLocaleString('de-DE')}</span>
}

/** Merkt sich den vorigen Wert je Schlüssel — für „mehr geworden" / „weniger geworden". */
export function useAenderungen(werte: Map<string, number>): Map<string, 'mehr' | 'weniger'> {
  const vorher = useRef<Map<string, number> | null>(null)
  const [aenderungen, setAenderungen] = useState<Map<string, 'mehr' | 'weniger'>>(new Map())
  const signatur = [...werte].map(([k, v]) => `${k}=${v}`).join('|')
  // Abhängigkeit ist die Signatur — sie steht für den Inhalt der Map.
  useEffect(() => {
    const alt = vorher.current
    vorher.current = new Map(werte)
    if (!alt) return
    const neu = new Map<string, 'mehr' | 'weniger'>()
    for (const [k, v] of werte) {
      const a = alt.get(k) ?? 0
      if (v > a) neu.set(k, 'mehr')
      else if (v < a) neu.set(k, 'weniger')
    }
    if (neu.size === 0) return
    setAenderungen(neu)
    const t = setTimeout(() => setAenderungen(new Map()), 1600)
    return () => clearTimeout(t)
  }, [signatur])
  return aenderungen
}

function alleWerte(knoten: MontageKnoten[], ziel = new Map<string, number>()): Map<string, number> {
  for (const k of knoten) {
    ziel.set(k.schluessel, k.offen)
    alleWerte(k.kinder, ziel)
  }
  return ziel
}

function Blatt({ k, max, puls }: { k: MontageKnoten; max: number; puls?: 'mehr' | 'weniger' }) {
  return (
    <li className={`montage-blatt${puls ? ` puls-${puls}` : ''}`}>
      <span className="montage-blatt-name">{k.label}</span>
      <span className="montage-balken" aria-hidden="true">
        <span style={{ width: `${max > 0 ? Math.max(3, (k.offen / max) * 100) : 0}%` }} />
      </span>
      <Zahl wert={k.offen} />
    </li>
  )
}

function Gruppe({ k, max, puls }: { k: MontageKnoten; max: number; puls: Map<string, 'mehr' | 'weniger'> }) {
  const p = puls.get(k.schluessel)
  // Unterste Ebene: Balken. Darüber: Kästen, die sich weiter teilen.
  if (k.kinder.length === 0) return <ul className="montage-blaetter"><Blatt k={k} max={max} puls={p} /></ul>
  const blattEbene = k.kinder.every((c) => c.kinder.length === 0)
  return (
    <section className={`montage-gruppe${p ? ` puls-${p}` : ''}`}>
      <header>
        <span className="montage-gruppe-name">{k.label}</span>
        <Zahl wert={k.offen} />
      </header>
      {blattEbene ? (
        <ul className="montage-blaetter">
          {k.kinder.map((c) => (
            <Blatt key={c.schluessel} k={c} max={max} puls={puls.get(c.schluessel)} />
          ))}
        </ul>
      ) : (
        k.kinder.map((c) => <Gruppe key={c.schluessel} k={c} max={max} puls={puls} />)
      )}
    </section>
  )
}

function groesstesBlatt(knoten: MontageKnoten[]): number {
  let max = 0
  for (const k of knoten) max = Math.max(max, k.kinder.length === 0 ? k.offen : groesstesBlatt(k.kinder))
  return max
}

export function MontageBrett({ anfang }: { anfang: MontageStand }) {
  const [stand, setStand] = useState(anfang)
  const [fehler, setFehler] = useState<string | null>(null)
  const [alter, setAlter] = useState(0)
  const brett = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let lebt = true
    const laden = async () => {
      if (document.hidden) return
      try {
        const r = await fetch('/api/montage', { cache: 'no-store' })
        if (!r.ok) throw new Error(r.status === 401 ? 'Abgemeldet — bitte neu anmelden' : `Fehler ${r.status}`)
        const neu = (await r.json()) as MontageStand
        if (!lebt) return
        setStand(neu)
        setFehler(null)
      } catch (err) {
        if (lebt) setFehler(err instanceof Error ? err.message : 'Keine Verbindung')
      }
    }
    const takt = setInterval(laden, TAKT_MS)
    const sichtbar = () => { if (!document.hidden) void laden() }
    document.addEventListener('visibilitychange', sichtbar)
    return () => {
      lebt = false
      clearInterval(takt)
      document.removeEventListener('visibilitychange', sichtbar)
    }
  }, [])

  // „vor 3 s" — läuft jede Sekunde, damit ein stehengebliebenes Brett auffällt.
  useEffect(() => {
    const t = setInterval(() => setAlter(Math.max(0, Math.round((Date.now() - new Date(stand.stand).getTime()) / 1000))), 1000)
    return () => clearInterval(t)
  }, [stand.stand])

  const puls = useAenderungen(alleWerte(stand.knoten).set('#gesamt', stand.gesamt))
  const max = groesstesBlatt(stand.knoten)
  const veraltet = fehler !== null || alter > 20

  return (
    <div ref={brett} className="montage-brett">
      <div className="montage-kopf">
        <div className={`montage-gesamt${puls.get('#gesamt') ? ` puls-${puls.get('#gesamt')}` : ''}`}>
          <span className="montage-kopf-titel">Noch zu bauen</span>
          <Zahl wert={stand.gesamt} />
          <span className="montage-kopf-neben">
            in {stand.auftraege.toLocaleString('de-DE')} {stand.auftraege === 1 ? 'Auftrag' : 'Aufträgen'}
          </span>
        </div>
        <div className="montage-gesamt fertig">
          <span className="montage-kopf-titel">Heute fertig</span>
          <Zahl wert={stand.fertigHeute} />
        </div>
        <div className="montage-live" role="status">
          <span className={`montage-punkt${veraltet ? ' aus' : ''}`} aria-hidden="true" />
          {fehler ? fehler : veraltet ? `Stand vor ${alter} s` : 'Live'}
          <button
            type="button"
            className="small"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen()
              else void brett.current?.requestFullscreen?.()
            }}
          >
            Vollbild
          </button>
        </div>
      </div>

      {stand.gesamt === 0 ? (
        <p className="montage-leer">Nichts offen — alle Fertigungsaufträge sind gebaut.</p>
      ) : (
        <>
          {stand.buendel.length > 1 && (
            <div className="montage-buendel" aria-label="Größte Bündel">
              <span className="mono-label">Am Stück vorbereiten</span>
              {stand.buendel.map((b) => (
                <span key={b.schluessel} className={`montage-chip${puls.get(b.schluessel) ? ` puls-${puls.get(b.schluessel)}` : ''}`}>
                  <strong><Zahl wert={b.offen} /> ×</strong> {b.pfad.join(' · ')}
                </span>
              ))}
            </div>
          )}
          <div className="montage-spalten">
            {stand.knoten.map((k) => (
              <div key={k.schluessel} className={`montage-spalte${puls.get(k.schluessel) ? ` puls-${puls.get(k.schluessel)}` : ''}`}>
                <div className="montage-spalte-kopf">
                  <span className="montage-spalte-name">{k.label}</span>
                  <Zahl wert={k.offen} />
                </div>
                {k.kinder.length === 0 ? null : k.kinder.every((c) => c.kinder.length === 0) ? (
                  <ul className="montage-blaetter">
                    {k.kinder.map((c) => (
                      <Blatt key={c.schluessel} k={c} max={max} puls={puls.get(c.schluessel)} />
                    ))}
                  </ul>
                ) : (
                  k.kinder.map((c) => <Gruppe key={c.schluessel} k={c} max={max} puls={puls} />)
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
