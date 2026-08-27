'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { packtischFertig } from './actions'
import { isActionError } from '@/modules/shared/action'
import type { PacktischDoc } from '@/app/api/packtisch/lookup/route'

/**
 * Packtisch-Arbeitsplatz: die Scan-Maschine des Scanner-Arbeitsplatzes,
 * zugeschnitten auf den Versand. Ablauf: VERSAND-Code vom Zettel scannen →
 * Bestellung mit Adresse und Paketinhalt erscheint → jede Position per
 * SKU-/Barcode-Scan (oder Knopf) abhaken → wenn alles vollständig ist,
 * VERSAND-Code erneut scannen → die Registry-Aktion erledigt Label,
 * Warenausgang, Kartonage und Shop-Rückmeldung in einem Zug. Das Label
 * öffnet sich als Tab (Fallback, bis die Druckbrücke es still druckt).
 *
 * Anders als am Scanner gibt es KEINE Teilmengen: das Paket ist erst dann
 * ein Paket, wenn alles drin ist — die Aktion prüft serverseitig dasselbe.
 */

type Phase = 'idle' | 'work' | 'confirm' | 'booking' | 'done'

interface Feedback {
  text: ReactNode
  tone: 'ok' | 'warn' | 'error' | 'info'
}

const TON_WORT: Record<Feedback['tone'], string> = {
  ok: 'OK',
  warn: 'Achtung',
  error: 'Fehler',
  info: 'Info',
}

const PHASE_ANZEIGE: Record<Phase, { led: string; wort: string }> = {
  idle: { led: 'on', wort: 'Bereit' },
  work: { led: 'on', wort: 'Packen' },
  confirm: { led: 'warn', wort: 'Bestätigen' },
  booking: { led: 'warn', wort: 'Bucht' },
  done: { led: 'ok', wort: 'Versandfertig' },
}

function playBeep(kind: 'ok' | 'warn' | 'error') {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.value = 0.08
    gain.connect(ctx.destination)
    const tone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime + start + dur)
    }
    if (kind === 'ok') tone(1320, 0, 0.08)
    if (kind === 'warn') {
      tone(880, 0, 0.09)
      tone(880, 0.14, 0.09)
    }
    if (kind === 'error') tone(220, 0, 0.35)
    setTimeout(() => ctx.close(), 700)
  } catch {
    // Ohne Audio (z. B. Autoplay-Sperre) läuft alles still weiter.
  }
}

/** Scan-Schlüssel einer Zeile: die SKU, sonst der Barcode (nie beides leer —
 * der Lookup weist Positionen ohne Code mit Klartext ab). */
function zeilenSchluessel(l: PacktischDoc['lines'][number]): string {
  return l.sku ?? l.barcode ?? ''
}

export function Packtisch() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [doc, setDoc] = useState<PacktischDoc | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [weightG, setWeightG] = useState<string>('')
  const [dhlProduct, setDhlProduct] = useState<string>('')
  const [labelLink, setLabelLink] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [flash, setFlash] = useState<'ok' | 'error' | null>(null)

  const refocus = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [])

  useEffect(() => {
    refocus()
  }, [refocus, phase])

  const say = useCallback((text: ReactNode, tone: Feedback['tone']) => {
    setFeedback({ text, tone })
    if (tone === 'ok') playBeep('ok')
    if (tone === 'warn') playBeep('warn')
    if (tone === 'error') playBeep('error')
    setFlash(tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : null)
    setTimeout(() => setFlash(null), 350)
  }, [])

  const reset = useCallback(() => {
    setPhase('idle')
    setDoc(null)
    setCounts({})
    setWeightG('')
    setDhlProduct('')
    setLabelLink(null)
    setFeedback(null)
    refocus()
  }, [refocus])

  const complete = doc
    ? doc.lines.every((l) => (counts[l.variantId] ?? 0) >= Number(l.qty))
    : false
  const fertigeZeilen = doc
    ? doc.lines.filter((l) => (counts[l.variantId] ?? 0) >= Number(l.qty)).length
    : 0

  async function loadDoc(code: string) {
    const res = await fetch(`/api/packtisch/lookup?code=${encodeURIComponent(code)}`)
    const data = await res.json()
    if (!res.ok) {
      say(data.error ?? 'Lieferung nicht gefunden', 'error')
      return
    }
    const loaded = data as PacktischDoc
    setDoc(loaded)
    setCounts(Object.fromEntries(loaded.lines.map((l) => [l.variantId, 0])))
    setWeightG(loaded.weightG != null && loaded.weightG > 0 ? String(loaded.weightG) : '')
    setDhlProduct(loaded.dhlProduct ?? '')
    setPhase('work')
    say(
      <>
        <span className="mono">{loaded.number}</span> geladen — Artikel scannen
        {loaded.labelVorhanden ? ' (Label existiert schon und wird wiederverwendet)' : ''}
      </>,
      loaded.labelVorhanden ? 'warn' : 'ok',
    )
  }

  function scanProduct(code: string) {
    if (!doc) return
    const norm = code.toLowerCase()
    const line = doc.lines.find(
      (l) => l.barcode?.toLowerCase() === norm || l.sku?.toLowerCase() === norm,
    )
    if (!line) {
      say(
        <>
          &quot;<span className="mono">{code}</span>&quot; gehört nicht in dieses Paket
        </>,
        'error',
      )
      return
    }
    const current = counts[line.variantId] ?? 0
    if (current >= Number(line.qty)) {
      say(
        <>
          {line.product}: Sollmenge (<span className="mono">{line.qty}</span>) bereits erreicht
        </>,
        'warn',
      )
      return
    }
    setCounts((c) => ({ ...c, [line.variantId]: current + 1 }))
    say(
      <>
        {line.product}:{' '}
        <span className="mono">
          {current + 1} / {line.qty}
        </span>
      </>,
      'ok',
    )
  }

  async function book() {
    if (!doc) return
    setPhase('booking')
    const fd = new FormData()
    // Schlüssel = SKU/Barcode: genau das prüft die Aktion serverseitig
    // (gescannt ⊇ Soll). Gleiche Schlüssel über Zeilen summieren sich.
    const gepackt: Record<string, number> = {}
    for (const l of doc.lines) {
      const key = zeilenSchluessel(l)
      gepackt[key] = (gepackt[key] ?? 0) + (counts[l.variantId] ?? 0)
    }
    for (const [key, menge] of Object.entries(gepackt)) fd.set(`gepackt_${key}`, String(menge))
    if (weightG && Number(weightG) > 0) fd.set('weight_g', weightG)
    if (dhlProduct) fd.set('dhl_product', dhlProduct)
    try {
      const result = await packtischFertig(doc.pickingId, fd)
      if (isActionError(result)) {
        setPhase('confirm')
        say(result.error, 'error')
        return
      }
      const link = result && 'link' in result ? (result.link ?? null) : null
      setLabelLink(link)
      setPhase('done')
      // Tab-Fallback bis zur Druckbrücke: das Label sofort öffnen, damit
      // am Tisch gedruckt werden kann. Popup-Blocker fangen wir mit dem
      // Knopf darunter ab.
      if (link) window.open(link, '_blank', 'noopener')
      say(
        <>
          <span className="mono">{doc.number}</span> versandfertig — Label bereit
        </>,
        'ok',
      )
    } catch (err) {
      setPhase('confirm')
      say(err instanceof Error ? err.message : 'Abschluss fehlgeschlagen', 'error')
    }
  }

  function onScan(raw: string) {
    const code = raw.trim()
    if (!code) return
    if (phase === 'idle') {
      void loadDoc(code)
      return
    }
    if (!doc) return
    const isDocCode = code.toLowerCase() === doc.number.toLowerCase()
    if (phase === 'work') {
      if (isDocCode) {
        if (!complete) {
          say('Noch nicht alles im Paket — erst alle Positionen scannen', 'warn')
          return
        }
        setPhase('confirm')
        say('Alles im Paket — Versand-Code erneut scannen erstellt das Label', 'ok')
      } else {
        scanProduct(code)
      }
      return
    }
    if (phase === 'confirm') {
      if (isDocCode) void book()
      else say('Zum Abschließen bitte den Versand-Code scannen', 'warn')
      return
    }
    if (phase === 'done') {
      // Der nächste Zettel startet direkt den nächsten Vorgang.
      reset()
      void loadDoc(code)
    }
  }

  const adjust = (variantId: string, delta: number, max: number) => {
    setCounts((c) => ({
      ...c,
      [variantId]: Math.min(Math.max((c[variantId] ?? 0) + delta, 0), max),
    }))
    refocus()
  }

  return (
    // Klick irgendwo holt den Fokus zurück ins Scanfeld.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className={`scanner${flash ? ` flash-${flash}` : ''}`} onClick={refocus}>
      <input
        ref={inputRef}
        className="scanner-input"
        autoFocus
        aria-label="Packtisch-Eingabe"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onScan(e.currentTarget.value)
            e.currentTarget.value = ''
          }
          if (e.key === 'Escape' && phase !== 'booking') reset()
        }}
        onBlur={refocus}
      />

      {feedback && (
        <div className={`scanner-feedback ${feedback.tone}`}>
          <span className="mono-label" style={{ color: 'inherit' }}>
            {TON_WORT[feedback.tone]}
          </span>
          <span>{feedback.text}</span>
        </div>
      )}

      {phase === 'idle' && (
        <div className="scanner-idle">
          <div className="display-panel">
            <div className="display-head">
              <span>Packtisch</span>
              <span>
                <span className="led on" /> {PHASE_ANZEIGE.idle.wort}
              </span>
            </div>
            <div className="scanner-icon" aria-hidden style={{ color: 'var(--display-text)' }}>
              ▮▯▮▮▯
            </div>
            <div className="mono-label">Warte auf Versand-Code</div>
          </div>
          <h2>Versand-Code scannen</h2>
          <p className="muted">
            Den <span className="mono">VERSAND</span>-Barcode vom Fertigungs- oder Packzettel
            scannen (<span className="mono">WH/OUT/…</span>). Ohne Scanner: Liefer- oder
            Auftragsnummer eintippen und Enter drücken.
          </p>
        </div>
      )}

      {doc && phase !== 'idle' && (
        <>
          <header className="scanner-head">
            <div className="display-panel" style={{ flex: 1 }}>
              <div className="display-head">
                <span>Sendung</span>
                <span>
                  <span className={`led ${PHASE_ANZEIGE[phase].led}`} /> {PHASE_ANZEIGE[phase].wort}
                </span>
              </div>
              <div className="mono scanner-number" style={{ color: 'var(--display-bright)' }}>
                {doc.number}
              </div>
              <div className="muted small">
                {[doc.auftrag, doc.shopify, doc.kunde].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="actions" style={{ gap: 16 }}>
              <div>
                <div className="mono-label">Positionen</div>
                <div className="mono">
                  {fertigeZeilen} / {doc.lines.length}
                </div>
              </div>
              {doc.adresse.length > 0 && (
                <div>
                  <div className="mono-label">Lieferadresse</div>
                  <div className="small">{doc.adresse.join(', ')}</div>
                </div>
              )}
              <button className="small" type="button" onClick={reset}>
                Abbrechen (Esc)
              </button>
            </div>
          </header>

          <div className="scanner-lines">
            {doc.lines.map((l) => {
              const count = counts[l.variantId] ?? 0
              const full = count >= Number(l.qty)
              const zeilenLed = full ? 'ok' : count > 0 ? 'warn' : 'off'
              const zeilenWort = full ? 'im Paket' : count > 0 ? 'Teilmenge' : 'offen'
              return (
                <div key={l.variantId} className={`scanner-line${full ? ' complete' : ''}`}>
                  <div className="scanner-line-info">
                    <div className="scanner-line-name">{l.product}</div>
                    <div className="muted small mono">
                      <span className="mono-label">SKU</span> {l.sku ?? '—'}
                      {l.barcode ? (
                        <>
                          {' · '}
                          <span className="mono-label">BC</span> {l.barcode}
                        </>
                      ) : null}
                    </div>
                    <div className="actions">
                      <span className={`led ${zeilenLed}`} />
                      <span className="mono-label">{zeilenWort}</span>
                    </div>
                  </div>
                  <div className="scanner-line-qty">
                    <button
                      type="button"
                      className="small"
                      onClick={() => adjust(l.variantId, -1, Number(l.qty))}
                      disabled={phase === 'booking' || count === 0}
                      aria-label="eins weniger"
                    >
                      −
                    </button>
                    <span className={`scanner-count${full ? ' ok' : ''}`}>
                      {count}
                      <span className="muted"> / {l.qty} </span>
                      <span className="mono-label">{l.uom}</span>
                    </span>
                    <button
                      type="button"
                      className="small"
                      onClick={() => adjust(l.variantId, +1, Number(l.qty))}
                      disabled={phase === 'booking' || full}
                      aria-label="eins mehr"
                    >
                      +
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <footer className="scanner-foot">
            {phase === 'work' && (
              <>
                <div className="muted">
                  {complete
                    ? 'Alles im Paket — Versand-Code erneut scannen zum Abschließen.'
                    : 'Artikel scannen oder mit + abhaken. Teilmengen gibt es am Packtisch nicht.'}
                </div>
                <button
                  type="button"
                  className="big"
                  onClick={() => onScan(doc.number)}
                  disabled={!complete}
                >
                  Abschließen
                </button>
              </>
            )}

            {(phase === 'confirm' || phase === 'booking') && (
              <>
                <div>
                  <div className="actions" style={{ gap: 12, alignItems: 'flex-end' }}>
                    <label className="field" style={{ maxWidth: 160 }}>
                      <span>Gewicht (g)</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={weightG}
                        onChange={(e) => setWeightG(e.target.value)}
                        placeholder="Vorschlag"
                      />
                    </label>
                    <label className="field" style={{ maxWidth: 220 }}>
                      <span>DHL-Produkt</span>
                      <input
                        type="text"
                        value={dhlProduct}
                        onChange={(e) => setDhlProduct(e.target.value)}
                        placeholder="Regelvorschlag"
                      />
                    </label>
                  </div>
                  <div className="muted">
                    Label wird erstellt, der Warenausgang gebucht und Shopify mit Tracking
                    benachrichtigt. Zum Buchen den Versand-Code ein drittes Mal scannen — oder den
                    Knopf nutzen.
                  </div>
                </div>
                <button
                  type="button"
                  className="primary big"
                  onClick={() => void book()}
                  disabled={phase === 'booking'}
                >
                  {phase === 'booking' ? (
                    'Erstellt Label…'
                  ) : (
                    <>
                      <span className="mono">{doc.number}</span> abschließen
                    </>
                  )}
                </button>
              </>
            )}

            {phase === 'done' && (
              <>
                <div className="scanner-done actions">
                  <span className="led ok" />
                  <span className="mono-label">Versandfertig</span>
                  <span className="mono">{doc.number}</span>
                  {labelLink && (
                    <a className="badge success" href={labelLink} target="_blank" rel="noopener">
                      Label öffnen
                    </a>
                  )}
                </div>
                <button type="button" className="big" onClick={reset}>
                  Nächstes Paket
                </button>
              </>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
