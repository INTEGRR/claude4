'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { validatePicking } from '../lager/actions'
import { produceMo } from '../fertigung/actions'
import { isActionError } from '@/modules/shared/action'
import { Badge } from '@/components/ui'
import type { ScannerDoc } from '@/app/api/scanner/lookup/route'

/**
 * Scanner-Arbeitsplatz: ein unsichtbares, dauerfokussiertes Eingabefeld
 * nimmt die Scans eines Keyboard-Wedge-Scanners entgegen (Scanner tippt
 * Code + Enter). Ablauf: Beleg scannen → Positionen per Produkt-Scan
 * abhaken → Doppelscan des Belegs bestätigt → dritter Scan (oder Knopf)
 * bucht über die vorhandenen Server Actions.
 */

type Phase = 'idle' | 'work' | 'confirm' | 'booking' | 'done'

interface Feedback {
  text: ReactNode
  tone: 'ok' | 'warn' | 'error' | 'info'
}

/** Zustand wird nie allein über Farbe gezeigt: zur Leuchte gehört das Wort. */
const TON_WORT: Record<Feedback['tone'], string> = {
  ok: 'OK',
  warn: 'Achtung',
  error: 'Fehler',
  info: 'Info',
}

/** Phase des Geräts als Leuchte + Wort (laufend = Akzent, wie in der Fertigung). */
const PHASE_ANZEIGE: Record<Phase, { led: string; wort: string }> = {
  idle: { led: 'on', wort: 'Bereit' },
  work: { led: 'on', wort: 'Erfassung' },
  confirm: { led: 'warn', wort: 'Bestätigen' },
  booking: { led: 'warn', wort: 'Bucht' },
  done: { led: 'ok', wort: 'Gebucht' },
}

/**
 * Darf ein Element den Fokus behalten? Das unsichtbare Scanfeld holt sich
 * den Fokus nur zurück, wenn er ins Leere ging — sichtbare Eingabefelder
 * (Nummer eintippen, Fertigmenge, Verbrauchsmodus) und Knöpfe bleiben
 * bedienbar.
 */
function fokusBleibtFrei(el: EventTarget | null): boolean {
  return el instanceof Element && Boolean(el.closest('input, button, select, textarea, a, label'))
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

export function Scanner({ canPickings, canMos }: { canPickings: boolean; canMos: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [doc, setDoc] = useState<ScannerDoc | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [produceQty, setProduceQty] = useState<number>(0)
  // Fertigungsauftrag: Scans sind primär eine Checkliste. Gebucht werden
  // standardmäßig die Sollmengen — abweichender Verbrauch nur auf
  // ausdrücklichen Wunsch, sonst entstehen Produkte ohne Materialverbrauch.
  const [moModus, setMoModus] = useState<'soll' | 'gescannt'>('soll')
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
    setProduceQty(0)
    setMoModus('soll')
    setFeedback(null)
    refocus()
  }, [refocus])

  const complete = doc ? doc.lines.every((l) => (counts[l.moveId] ?? 0) >= Number(l.qty)) : false
  const anyScanned = Object.values(counts).some((c) => c > 0)
  // Fortschritt als Kennzahl im Kopf: vollständige Positionen von allen.
  const fertigeZeilen = doc
    ? doc.lines.filter((l) => (counts[l.moveId] ?? 0) >= Number(l.qty)).length
    : 0

  async function loadDoc(code: string) {
    const res = await fetch(`/api/scanner/lookup?code=${encodeURIComponent(code)}`)
    const data = await res.json()
    if (!res.ok) {
      say(data.error ?? 'Beleg nicht gefunden', 'error')
      return
    }
    const loaded = data as ScannerDoc
    setDoc(loaded)
    setCounts(Object.fromEntries(loaded.lines.map((l) => [l.moveId, 0])))
    setProduceQty(loaded.remaining ?? 0)
    setPhase('work')
    say(
      <>
        <span className="mono">{loaded.number}</span> geladen — Positionen scannen oder Beleg erneut
        scannen
      </>,
      'ok',
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
          &quot;<span className="mono">{code}</span>&quot; gehört nicht zu diesem Beleg
        </>,
        'error',
      )
      return
    }
    const current = counts[line.moveId] ?? 0
    if (current >= Number(line.qty)) {
      say(
        <>
          {line.product}: Sollmenge (<span className="mono">{line.qty}</span>) bereits erreicht
        </>,
        'warn',
      )
      return
    }
    setCounts((c) => ({ ...c, [line.moveId]: current + 1 }))
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
    if (doc.type === 'picking') {
      // Kommissionierung: gescannt = erledigt; Rest wandert in den Rückstand.
      // Ohne einen einzigen Scan werden die Sollmengen gebucht.
      if (anyScanned) {
        for (const l of doc.lines) fd.set(`done_${l.moveId}`, String(counts[l.moveId] ?? 0))
      }
      fd.set('backorder', 'yes')
    } else {
      // Fertigmeldung: Sollmengen sind der Standard. Nur wer den Modus
      // ausdrücklich umstellt, bucht die gescannten Mengen als Verbrauch.
      fd.set('qty', String(produceQty))
      if (anyScanned && !complete && moModus === 'gescannt') {
        for (const l of doc.lines) fd.set(`consumed_${l.moveId}`, String(counts[l.moveId] ?? 0))
      }
      fd.set('backorder', 'yes')
    }
    try {
      // Fachliche Fehler kommen als Rückgabewert zurück, nicht als Ausnahme.
      const result =
        doc.type === 'picking' ? await validatePicking(doc.id, fd) : await produceMo(doc.id, fd)
      if (isActionError(result)) {
        setPhase('confirm')
        say(result.error, 'error')
        return
      }
      setPhase('done')
      say(
        <>
          <span className="mono">{doc.number}</span> gebucht
        </>,
        'ok',
      )
      setTimeout(reset, 4000)
    } catch (err) {
      setPhase('confirm')
      say(err instanceof Error ? err.message : 'Buchung fehlgeschlagen', 'error')
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
        setPhase('confirm')
        say(
          complete
            ? 'Alle Positionen vollständig — zum Buchen Beleg erneut scannen'
            : 'Achtung: nicht alle Positionen vollständig — Rest geht in den Rückstand',
          complete ? 'ok' : 'warn',
        )
      } else {
        scanProduct(code)
      }
      return
    }
    if (phase === 'confirm') {
      if (isDocCode) void book()
      else say('Zum Buchen bitte den Beleg-Barcode scannen', 'warn')
    }
  }

  const adjust = (moveId: string, delta: number, max: number) => {
    setCounts((c) => ({
      ...c,
      [moveId]: Math.min(Math.max((c[moveId] ?? 0) + delta, 0), max),
    }))
    refocus()
  }

  return (
    // Klick auf freie Fläche holt den Fokus zurück ins Scanfeld —
    // Eingabefelder und Knöpfe behalten ihn (fokusBleibtFrei).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className={`scanner${flash ? ` flash-${flash}` : ''}`}
      onClick={(e) => {
        if (!fokusBleibtFrei(e.target)) refocus()
      }}
    >
      <input
        ref={inputRef}
        className="scanner-input"
        autoFocus
        aria-label="Scanner-Eingabe"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onScan(e.currentTarget.value)
            e.currentTarget.value = ''
          }
          if (e.key === 'Escape' && phase !== 'booking') reset()
        }}
        onBlur={(e) => {
          if (!fokusBleibtFrei(e.relatedTarget)) refocus()
        }}
      />

      {feedback && (
        // Der Punkt vor der Zeile ist die Leuchte, das Wort davor benennt den Ton.
        <div className={`scanner-feedback ${feedback.tone}`}>
          {/* `color: inherit` schlägt das --text-muted von .mono-label: das
              Tonwort muss die Farbe der Rückmeldung tragen, sonst steht ein
              graues Wort auf getönter Fläche (im dunklen Modus am schwächsten). */}
          <span className="mono-label" style={{ color: 'inherit' }}>
            {TON_WORT[feedback.tone]}
          </span>
          <span>{feedback.text}</span>
        </div>
      )}

      {phase === 'idle' && (
        <div className="scanner-idle">
          {/* Ruhezustand als Geräteanzeige: dunkle Fläche, Leuchte, Wort. */}
          <div className="display-panel">
            <div className="display-head">
              <span>Scanner-Eingang</span>
              <span>
                <span className="led on" /> {PHASE_ANZEIGE.idle.wort}
              </span>
            </div>
            <div className="scanner-icon" aria-hidden style={{ color: 'var(--display-text)' }}>
              ▮▯▮▮▯
            </div>
            <div className="mono-label">Warte auf Scan</div>
          </div>
          <h2>Beleg scannen</h2>
          <p className="muted">
            {canPickings && canMos ? (
              <>
                Transfer (<span className="mono">WH/…</span>) oder Fertigungsauftrag (
                <span className="mono">MO/…</span>) scannen, um zu starten.
              </>
            ) : canPickings ? (
              <>
                Transfer (<span className="mono">WH/…</span>) scannen, um zu starten.
              </>
            ) : (
              <>
                Fertigungsauftrag (<span className="mono">MO/…</span>) scannen, um zu starten.
              </>
            )}
          </p>
          {/* Tipp-Weg ohne Scanner: sichtbares Feld — nach dem Öffnen geht
              der Fokus zurück ans Scanfeld für die Positions-Scans. */}
          <form
            className="actions"
            style={{ justifyContent: 'center', marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              const feld = e.currentTarget.elements.namedItem('code') as HTMLInputElement
              const wert = feld.value.trim()
              if (!wert) return
              feld.value = ''
              onScan(wert)
              refocus()
            }}
          >
            <input
              name="code"
              type="text"
              className="mono"
              placeholder="Belegnummer (WH/… oder MO/…)"
              aria-label="Belegnummer eintippen"
              autoComplete="off"
              style={{ maxWidth: 260 }}
            />
            <button className="small" type="submit">Öffnen</button>
          </form>
        </div>
      )}

      {doc && phase !== 'idle' && (
        <>
          <header className="scanner-head">
            {/* Belegkopf als Geräteanzeige: Nummer groß, Phase als Leuchte + Wort. */}
            <div className="display-panel" style={{ flex: 1 }}>
              <div className="display-head">
                <span>Beleg</span>
                <span>
                  <span className={`led ${PHASE_ANZEIGE[phase].led}`} /> {PHASE_ANZEIGE[phase].wort}
                </span>
              </div>
              <div className="mono scanner-number" style={{ color: 'var(--display-bright)' }}>
                {doc.number}
              </div>
              <div className="muted small">
                {doc.label}
                {doc.sub ? ` · ${doc.sub}` : ''}
              </div>
            </div>
            <div className="actions" style={{ gap: 16 }}>
              <div>
                <div className="mono-label">Positionen</div>
                <div className="mono">
                  {fertigeZeilen} / {doc.lines.length}
                </div>
              </div>
              {doc.type === 'mo' && doc.remaining !== undefined && (
                <div>
                  <div className="mono-label">Rest zu fertigen</div>
                  <div className="mono">{doc.remaining}</div>
                </div>
              )}
              <Badge state={doc.state} kind={doc.type} />
              <button className="small" type="button" onClick={reset}>
                Abbrechen (Esc)
              </button>
            </div>
          </header>

          <div className="scanner-lines">
            {doc.lines.length === 0 && (
              <div className="empty">Keine offenen Positionen — direkt bestätigen.</div>
            )}
            {doc.lines.map((l) => {
              const count = counts[l.moveId] ?? 0
              const full = count >= Number(l.qty)
              // Vollständigkeit nie nur über die grüne Fläche: Leuchte + Wort.
              const zeilenLed = full ? 'ok' : count > 0 ? 'warn' : 'off'
              const zeilenWort = full ? 'vollständig' : count > 0 ? 'Teilmenge' : 'offen'
              return (
                <div key={l.moveId} className={`scanner-line${full ? ' complete' : ''}`}>
                  <div className="scanner-line-info">
                    <div className="scanner-line-name">{l.product}</div>
                    <div className="muted small mono">
                      <span className="mono-label">BC</span> {l.barcode ?? '—'}
                      {l.sku ? (
                        <>
                          {' · '}
                          <span className="mono-label">SKU</span> {l.sku}
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
                      onClick={() => adjust(l.moveId, -1, Number(l.qty))}
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
                      onClick={() => adjust(l.moveId, +1, Number(l.qty))}
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
                    ? 'Alles gescannt — Beleg erneut scannen zum Bestätigen.'
                    : anyScanned
                      ? 'Weiter scannen — oder Beleg scannen, um mit Teilmengen abzuschließen.'
                      : 'Positionen scannen — oder Beleg erneut scannen, um alles wie geplant zu buchen.'}
                </div>
                {/* Diese Taste bucht nicht, sie wechselt nur in die Bestätigung: neutral. */}
                <button type="button" className="big" onClick={() => onScan(doc.number)}>
                  Abschließen
                </button>
              </>
            )}

            {(phase === 'confirm' || phase === 'booking') && (
              <>
                <div>
                  {doc.type === 'mo' && (
                    <label className="field" style={{ maxWidth: 220 }}>
                      <span>Fertigzumeldende Menge</span>
                      <input
                        type="number"
                        min={0.001}
                        step="0.001"
                        value={produceQty}
                        onChange={(e) => setProduceQty(Number(e.target.value))}
                      />
                    </label>
                  )}
                  {doc.type === 'mo' && anyScanned && !complete && (
                    <div>
                      <div className="mono-label">Verbrauchsmodus</div>
                      <label className="field">
                        <input
                          type="radio"
                          name="mo-modus"
                          checked={moModus === 'soll'}
                          onChange={() => setMoModus('soll')}
                        />{' '}
                        Sollmengen verbrauchen (Scans waren nur Kontrolle)
                      </label>
                      <label className="field">
                        <input
                          type="radio"
                          name="mo-modus"
                          checked={moModus === 'gescannt'}
                          onChange={() => setMoModus('gescannt')}
                        />{' '}
                        Nur gescannte Mengen verbrauchen (Abweichung buchen)
                      </label>
                    </div>
                  )}
                  <div className="muted">
                    {doc.type === 'picking'
                      ? anyScanned
                        ? 'Es werden die gescannten Mengen gebucht; Rest geht in den Rückstand.'
                        : 'Es werden die Sollmengen gebucht.'
                      : moModus === 'gescannt' && anyScanned && !complete
                        ? 'Es werden die gescannten Mengen als Verbrauch gebucht.'
                        : 'Komponenten werden mit den Sollmengen verbraucht.'}{' '}
                    Zum Buchen den Beleg ein drittes Mal scannen — oder den Knopf nutzen.
                  </div>
                </div>
                <button
                  type="button"
                  className="primary big"
                  onClick={() => void book()}
                  disabled={phase === 'booking'}
                >
                  {phase === 'booking' ? (
                    'Bucht…'
                  ) : (
                    <>
                      <span className="mono">{doc.number}</span> jetzt buchen
                    </>
                  )}
                </button>
              </>
            )}

            {phase === 'done' && (
              <>
                <div className="scanner-done actions">
                  <span className="led ok" />
                  <span className="mono-label">Gebucht</span>
                  <span className="mono">{doc.number}</span>
                </div>
                <button type="button" className="big" onClick={reset}>
                  Nächster Beleg
                </button>
              </>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
