'use client'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isActionError, isActionInfo } from '@/modules/shared/action'
import {
  type Gesammelt,
  fortschritt,
  naechsteOffene,
  sammelAbgleich,
  scanTreffer,
} from '@/modules/versand/kommissionier-logik'
import type { SammelDoc } from '@/modules/versand/kommissionieren'
import { dateTime } from '@/modules/shared/format'
import { packzettelDrucken, sammelnMelden } from '../actions'
import { StartenKnopf } from '../starten-knopf'

// Die Kamera (und @zxing/browser) lädt erst, wenn sie gebraucht wird.
const Kamera = dynamic(() => import('./kamera').then((m) => m.Kamera), { ssr: false })

/**
 * Der Sammel-Screen am Handy/Tablet (0091): geführt Artikel für Artikel,
 * sortiert nach Name (vorerst ohne Lagerplätze). Gescannt wird mit dem
 * Bluetooth-Handscanner (unsichtbares Eingabefeld ohne Bildschirmtastatur)
 * oder mit der Kamera; SKU eintippen geht immer. „Ohne Scan" gibt es nur
 * für Artikel ohne SKU und Barcode — das wird vermerkt. Der Fortschritt
 * liegt zusätzlich im Browser (localStorage), ein Reload verliert nichts;
 * gemeldet wird über lager.kommissionieren, das serverseitig dieselbe
 * Prüfung rechnet.
 */

type Phase = 'sammeln' | 'abschluss' | 'sendet' | 'fertig'

interface Rueckmeldung {
  text: ReactNode
  ton: 'ok' | 'warn' | 'error' | 'info'
}

interface Ablage {
  gesammelt: Gesammelt
  fehlt: string[]
  ohneScan: string[]
}

const ablageSchluessel = (pickingId: string) => `kommissionieren:${pickingId}`

function piep(art: 'ok' | 'warn' | 'error') {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = 0.08
    gain.connect(ctx.destination)
    const ton = (freq: number, start: number, dauer: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime + start + dauer)
    }
    if (art === 'ok') ton(1320, 0, 0.08)
    if (art === 'warn') {
      ton(880, 0, 0.09)
      ton(880, 0.14, 0.09)
    }
    if (art === 'error') ton(220, 0, 0.35)
    setTimeout(() => ctx.close(), 700)
  } catch {
    // Ohne Audio (Autoplay-Sperre) läuft alles still weiter.
  }
  // Handy: zusätzlich kurz vibrieren, wo erlaubt.
  try {
    navigator.vibrate?.(art === 'ok' ? 40 : art === 'warn' ? [60, 60, 60] : 300)
  } catch {
    // ohne Vibration
  }
}

/** Sichtbare Bedienelemente behalten den Fokus; sonst geht er zurück ans Scanfeld. */
function fokusBleibtFrei(el: EventTarget | null): boolean {
  return el instanceof Element && Boolean(el.closest('input, button, select, textarea, a, label'))
}

export function Sammeln({ doc, beansprucht }: { doc: SammelDoc; beansprucht: boolean }) {
  const positionen = doc.positionen
  const scanRef = useRef<HTMLInputElement>(null)
  // Neu sammeln nach einer Kommissionierung beginnt bei null; sonst mit dem
  // gespeicherten Teilstand (unvollständig gemeldet).
  const [gesammelt, setGesammelt] = useState<Gesammelt>(() =>
    Object.fromEntries(positionen.map((p) => [p.variantId, doc.kommissioniertAm ? 0 : p.gesammelt])),
  )
  const [fehlt, setFehlt] = useState<Set<string>>(new Set())
  const [ohneScan, setOhneScan] = useState<Set<string>>(new Set())
  const [auswahl, setAuswahl] = useState<string | null>(null)
  const [liste, setListe] = useState(false)
  const [kamera, setKamera] = useState(false)
  const [phase, setPhase] = useState<Phase>('sammeln')
  const [vermerk, setVermerk] = useState('')
  const [meldung, setMeldung] = useState<Rueckmeldung | null>(null)
  const [blitz, setBlitz] = useState<'ok' | 'error' | null>(null)
  const geladen = useRef(false)

  // Fortschritt aus dem Browser zurückholen (nach Reload/Funkloch) — erst
  // nach dem ersten Rendern, damit Server- und Client-HTML gleich bleiben.
  useEffect(() => {
    try {
      const roh = localStorage.getItem(ablageSchluessel(doc.pickingId))
      if (roh) {
        const a = JSON.parse(roh) as Partial<Ablage>
        const bekannt = new Set(positionen.map((p) => p.variantId))
        if (a.gesammelt) {
          setGesammelt((g) => {
            const neu = { ...g }
            for (const [k, v] of Object.entries(a.gesammelt ?? {})) {
              if (bekannt.has(k) && Number.isFinite(Number(v))) neu[k] = Number(v)
            }
            return neu
          })
        }
        if (Array.isArray(a.fehlt)) setFehlt(new Set(a.fehlt.filter((k) => bekannt.has(k))))
        if (Array.isArray(a.ohneScan)) setOhneScan(new Set(a.ohneScan.filter((k) => bekannt.has(k))))
      }
    } catch {
      // Ohne Ablage startet der Stand vom Server.
    }
    geladen.current = true
  }, [doc.pickingId, positionen])

  useEffect(() => {
    if (!geladen.current || phase === 'fertig') return
    try {
      const a: Ablage = { gesammelt, fehlt: [...fehlt], ohneScan: [...ohneScan] }
      localStorage.setItem(ablageSchluessel(doc.pickingId), JSON.stringify(a))
    } catch {
      // Speichern ist Komfort.
    }
  }, [gesammelt, fehlt, ohneScan, doc.pickingId, phase])

  const fokus = useCallback(() => {
    setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 30)
  }, [])
  useEffect(() => {
    fokus()
  }, [fokus, phase, kamera])

  const sag = useCallback((text: ReactNode, ton: Rueckmeldung['ton']) => {
    setMeldung({ text, ton })
    if (ton !== 'info') piep(ton)
    setBlitz(ton === 'ok' ? 'ok' : ton === 'error' ? 'error' : null)
    setTimeout(() => setBlitz(null), 350)
  }, [])

  const offen = naechsteOffene(positionen, gesammelt, fehlt)
  const aktuell = (auswahl ? positionen.find((p) => p.variantId === auswahl) : null) ?? offen
  const stand = fortschritt(positionen, gesammelt)
  const abgleich = useMemo(() => sammelAbgleich(positionen, gesammelt), [positionen, gesammelt])

  function setzen(variantId: string, menge: number) {
    setGesammelt((g) => ({ ...g, [variantId]: Math.max(0, menge) }))
  }

  function scan(roh: string) {
    const code = roh.trim()
    if (!code || phase === 'sendet' || phase === 'fertig') return
    if (code.toLowerCase() === doc.number.toLowerCase()) {
      if (!offen) setPhase('abschluss')
      else sag('Das ist der Versand-Code — erst die Artikel sammeln.', 'info')
      return
    }
    const r = scanTreffer(positionen, gesammelt, code)
    if (r.art === 'fremd') {
      sag(
        <>
          „<span className="mono">{code}</span>" gehört nicht zu dieser Bestellung
        </>,
        'error',
      )
      return
    }
    const pos = positionen.find((p) => p.variantId === r.variantId)!
    if (r.art === 'voll') {
      sag(`${pos.name}: schon vollständig (${pos.soll})`, 'warn')
      return
    }
    const neu = (gesammelt[pos.variantId] ?? 0) + 1
    setzen(pos.variantId, neu)
    if (fehlt.has(pos.variantId)) {
      setFehlt((f) => {
        const n = new Set(f)
        n.delete(pos.variantId)
        return n
      })
    }
    if (neu >= pos.soll && auswahl === pos.variantId) setAuswahl(null)
    sag(
      <>
        {pos.name}:{' '}
        <span className="mono">
          {neu} / {pos.soll}
        </span>
      </>,
      'ok',
    )
  }

  function ohneScanPlus(variantId: string) {
    const pos = positionen.find((p) => p.variantId === variantId)!
    const neu = Math.min((gesammelt[variantId] ?? 0) + 1, pos.soll)
    setzen(variantId, neu)
    setOhneScan((s) => new Set(s).add(variantId))
    sag(`${pos.name}: ${neu} / ${pos.soll} (ohne Scan)`, 'ok')
    fokus()
  }

  function alsFehlend(variantId: string) {
    setFehlt((f) => new Set(f).add(variantId))
    if (auswahl === variantId) setAuswahl(null)
    const pos = positionen.find((p) => p.variantId === variantId)!
    sag(`${pos.name} als fehlend markiert`, 'warn')
    fokus()
  }

  async function melden(unvollstaendig: boolean) {
    setPhase('sendet')
    const namen = (ids: Set<string>) =>
      positionen.filter((p) => ids.has(p.variantId)).map((p) => p.sku ?? p.name)
    const teile = [
      ohneScan.size > 0 ? `ohne Scan: ${namen(ohneScan).join(', ')}` : '',
      vermerk.trim(),
    ].filter(Boolean)
    try {
      const r = await sammelnMelden(doc.pickingId, {
        gesammelt,
        unvollstaendig,
        vermerk: teile.length > 0 ? teile.join(' — ').slice(0, 500) : undefined,
      })
      if (isActionError(r)) {
        setPhase('abschluss')
        sag(r.error, 'error')
        return
      }
      try {
        localStorage.removeItem(ablageSchluessel(doc.pickingId))
      } catch {
        // egal
      }
      setPhase('fertig')
      sag(isActionInfo(r) ? r.info : 'Gespeichert', unvollstaendig ? 'warn' : 'ok')
    } catch (err) {
      setPhase('abschluss')
      sag(err instanceof Error ? err.message : 'Melden fehlgeschlagen', 'error')
    }
  }

  async function zettel() {
    const r = await packzettelDrucken([doc.pickingId])
    if (isActionError(r)) {
      sag(r.error, 'error')
      return
    }
    if (isActionInfo(r)) {
      if (r.link) window.open(r.link, '_blank', 'noopener')
      sag(r.info, 'info')
    }
  }

  // Noch nicht beansprucht (oder die Sperre ist abgelaufen): Überblick und
  // der Knopf zum Beginnen. Nach dem Melden bleibt der Abschluss stehen.
  if (!beansprucht && phase !== 'fertig') {
    return (
      <div className="scanner kommi">
        <header className="kommi-kopf">
          <div>
            <div className="mono scanner-number">{doc.number}</div>
            <div className="muted small">
              {[doc.shopify ?? doc.auftrag, doc.kunde].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="kommi-stand">
            <span className="mono">{positionen.length}</span>
            <span className="mono-label">Artikel</span>
          </div>
        </header>
        {doc.kommissioniertAm && (
          <div className="notice success" style={{ margin: '10px 12px 0' }}>
            Bereits kommissioniert
            {doc.kommissioniertVon ? ` von ${doc.kommissioniertVon}` : ''} am{' '}
            {dateTime(doc.kommissioniertAm)} — die Ware wartet am Packtisch.
          </div>
        )}
        <ul className="kommi-uebersicht">
          {positionen.map((p) => (
            <li key={p.variantId}>
              <div className="kommi-uebersicht-knopf">
                <span className="kommi-uebersicht-name">{p.name}</span>
                <span className="mono">{p.soll}</span>
              </div>
            </li>
          ))}
        </ul>
        <div style={{ padding: 12 }}>
          <StartenKnopf className="primary big kommi-breit" pickingId={doc.pickingId}>
            {doc.kommissioniertAm ? 'Neu sammeln' : 'Sammeln beginnen'}
          </StartenKnopf>
        </div>
      </div>
    )
  }

  return (
    // Tippen auf freie Fläche holt den Fokus ans Scanfeld zurück.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className={`scanner kommi${blitz ? ` flash-${blitz}` : ''}`}
      onClick={(e) => {
        if (!fokusBleibtFrei(e.target)) fokus()
      }}
    >
      <input
        ref={scanRef}
        className="scanner-input"
        inputMode="none"
        autoComplete="off"
        aria-label="Scanner-Eingabe"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            scan(e.currentTarget.value)
            e.currentTarget.value = ''
          }
        }}
        onBlur={(e) => {
          if (!fokusBleibtFrei(e.relatedTarget)) fokus()
        }}
      />

      <header className="kommi-kopf">
        <div>
          <div className="mono scanner-number">{doc.number}</div>
          <div className="muted small">
            {[doc.shopify ?? doc.auftrag, doc.kunde].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="kommi-stand">
          <span className="mono">
            {stand.ist} / {stand.soll}
          </span>
          <span className="mono-label">Stück</span>
        </div>
      </header>
      <div className="kommi-balken" aria-hidden>
        <div style={{ width: `${stand.soll ? (100 * stand.ist) / stand.soll : 0}%` }} />
      </div>

      {meldung && (
        <div className={`scanner-feedback ${meldung.ton}`} role="status">
          <span>{meldung.text}</span>
        </div>
      )}

      {doc.kundennotiz && phase !== 'fertig' && (
        <div className="notice" style={{ margin: '10px 12px 0' }}>
          <span className="mono-label">Kundennotiz</span> {doc.kundennotiz}
        </div>
      )}

      {kamera && phase === 'sammeln' && (
        <Kamera
          onCode={scan}
          onSchliessen={() => {
            setKamera(false)
            fokus()
          }}
        />
      )}

      {phase === 'sammeln' && !liste && aktuell && (
        <SammelKarte
          pos={aktuell}
          ist={gesammelt[aktuell.variantId] ?? 0}
          fehltMarkiert={fehlt.has(aktuell.variantId)}
          onPlus={() => ohneScanPlus(aktuell.variantId)}
          onMinus={() => {
            setzen(aktuell.variantId, (gesammelt[aktuell.variantId] ?? 0) - 1)
            fokus()
          }}
          onFehlt={() => alsFehlend(aktuell.variantId)}
        />
      )}

      {phase === 'sammeln' && !liste && !aktuell && (
        <div className="scanner-idle">
          <h2>Alles durch</h2>
          <p className="muted">
            {abgleich.vollstaendig
              ? 'Alle Artikel sind gesammelt.'
              : `Es fehlt noch: ${abgleich.fehlend.join(', ')}`}
          </p>
          <button type="button" className="primary big" onClick={() => setPhase('abschluss')}>
            Weiter zum Abschluss
          </button>
        </div>
      )}

      {phase === 'sammeln' && liste && (
        <ul className="kommi-uebersicht">
          {positionen.map((p) => {
            const ist = gesammelt[p.variantId] ?? 0
            const voll = ist >= p.soll
            return (
              <li key={p.variantId} className={voll ? 'complete' : fehlt.has(p.variantId) ? 'fehlt' : ''}>
                <button
                  type="button"
                  className="kommi-uebersicht-knopf"
                  onClick={() => {
                    setAuswahl(p.variantId)
                    setListe(false)
                    fokus()
                  }}
                >
                  <span>
                    <span className="kommi-uebersicht-name">{p.name}</span>
                    <span className="mono small muted"> {p.sku ?? p.barcode ?? 'ohne Code'}</span>
                  </span>
                  <span className="mono">
                    {ist}/{p.soll}
                    {fehlt.has(p.variantId) ? ' · fehlt' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {(phase === 'abschluss' || phase === 'sendet') && (
        <div className="kommi-abschluss">
          <ul className="kommi-uebersicht">
            {positionen.map((p) => {
              const ist = gesammelt[p.variantId] ?? 0
              return (
                <li key={p.variantId} className={ist >= p.soll ? 'complete' : 'fehlt'}>
                  <div className="kommi-uebersicht-knopf">
                    <span className="kommi-uebersicht-name">{p.name}</span>
                    <span className="mono">
                      {ist}/{p.soll}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
          {abgleich.vollstaendig ? (
            <button
              type="button"
              className="primary big kommi-breit"
              disabled={phase === 'sendet'}
              onClick={() => void melden(false)}
            >
              {phase === 'sendet' ? 'Meldet…' : 'Kommissioniert — Ware zum Packtisch'}
            </button>
          ) : (
            <>
              <label className="field">
                <span>Vermerk (was fehlt, warum)</span>
                <textarea
                  rows={2}
                  maxLength={400}
                  value={vermerk}
                  onChange={(e) => setVermerk(e.target.value)}
                  placeholder="z. B. Fach leer, Nachlieferung abwarten"
                />
              </label>
              <button
                type="button"
                className="big kommi-breit"
                disabled={phase === 'sendet'}
                onClick={() => void melden(true)}
              >
                {phase === 'sendet' ? 'Speichert…' : 'Unvollständig speichern'}
              </button>
            </>
          )}
          <button
            type="button"
            className="small"
            disabled={phase === 'sendet'}
            onClick={() => {
              setPhase('sammeln')
              setFehlt(new Set())
            }}
          >
            Zurück zum Sammeln
          </button>
        </div>
      )}

      {phase === 'fertig' && (
        <div className="scanner-idle">
          <h2>{abgleich.vollstaendig ? 'Kommissioniert' : 'Gespeichert'}</h2>
          <p className="muted">
            {abgleich.vollstaendig
              ? 'Ware zum Packtisch bringen — dort wird jeder Artikel noch einmal gescannt.'
              : 'Die Bestellung bleibt im Vorrat; der Fehlbestand steht im Verlauf der Lieferung.'}
          </p>
          <Link className="btn primary big" href="/kommissionieren">
            Nächste Bestellung
          </Link>
        </div>
      )}

      {phase === 'sammeln' && (
        <footer className="kommi-fuss">
          <button type="button" onClick={() => setKamera((k) => !k)}>
            {kamera ? 'Kamera aus' : 'Kamera'}
          </button>
          <button type="button" onClick={() => setListe((l) => !l)}>
            {liste ? 'Geführt' : 'Übersicht'}
          </button>
          <form
            className="kommi-tippen"
            onSubmit={(e) => {
              e.preventDefault()
              const feld = e.currentTarget.elements.namedItem('code') as HTMLInputElement
              scan(feld.value)
              feld.value = ''
              fokus()
            }}
          >
            <input
              name="code"
              className="mono"
              placeholder="SKU eintippen"
              aria-label="SKU oder Barcode eintippen"
              autoComplete="off"
              autoCapitalize="characters"
            />
            <button type="submit" className="small">
              OK
            </button>
          </form>
          <button type="button" onClick={() => setPhase('abschluss')}>
            Abschließen
          </button>
          <button type="button" className="small" onClick={() => void zettel()}>
            Packzettel drucken
          </button>
        </footer>
      )}
    </div>
  )
}

function SammelKarte({
  pos,
  ist,
  fehltMarkiert,
  onPlus,
  onMinus,
  onFehlt,
}: {
  pos: SammelDoc['positionen'][number]
  ist: number
  fehltMarkiert: boolean
  onPlus: () => void
  onMinus: () => void
  onFehlt: () => void
}) {
  const ohneCode = !pos.sku && !pos.barcode
  const voll = ist >= pos.soll
  return (
    <section className={`kommi-karte${voll ? ' complete' : ''}`}>
      <div className="kommi-karte-name">{pos.name}</div>
      <div className="mono small">
        {pos.sku ? (
          <>
            <span className="mono-label">SKU</span> {pos.sku}
          </>
        ) : null}
        {pos.barcode ? (
          <>
            {pos.sku ? ' · ' : ''}
            <span className="mono-label">BC</span> {pos.barcode}
          </>
        ) : null}
        {ohneCode && <span className="mono-label">ohne Code — von Hand bestätigen</span>}
      </div>
      {pos.belegtext && <div className="small muted">{pos.belegtext}</div>}
      <div className="kommi-karte-menge">
        <span className={voll ? 'ok' : ''}>{ist}</span>
        <span className="muted"> / {pos.soll}</span> <span className="mono-label">{pos.uom}</span>
      </div>
      {fehltMarkiert && <div className="mono-label" style={{ color: 'var(--warn)' }}>als fehlend markiert</div>}
      <div className="kommi-karte-knoepfe">
        <button type="button" onClick={onMinus} disabled={ist === 0} aria-label="eins weniger">
          −1
        </button>
        {ohneCode && (
          <button type="button" className="primary" onClick={onPlus} disabled={voll}>
            +1 ohne Scan
          </button>
        )}
        <button type="button" onClick={onFehlt} disabled={voll}>
          Fehlt
        </button>
      </div>
      {!ohneCode && !voll && <div className="muted small">Artikel scannen (Handscanner oder Kamera)</div>}
    </section>
  )
}
