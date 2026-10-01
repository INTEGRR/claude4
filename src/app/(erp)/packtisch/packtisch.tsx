'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { adressePruefen, artikelgewichtSetzen, packtischFertig } from './actions'
import { isActionError, isActionInfo } from '@/modules/shared/action'
import type { PacktischDoc } from '@/modules/versand/packtisch-beleg'
import { type AnsageSchluessel, ansageFuerFehler } from '@/modules/scanner-ansagen'
import { scanGleich } from '@/modules/shared/scan'

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

/**
 * Darf ein Element den Fokus behalten? Das unsichtbare Scanfeld holt sich
 * den Fokus nur zurück, wenn er ins Leere ging — sichtbare Eingabefelder
 * (Nummer eintippen, Gewicht, DHL-Produkt) und Knöpfe bleiben bedienbar.
 */
function fokusBleibtFrei(el: EventTarget | null): boolean {
  return el instanceof Element && Boolean(el.closest('input, button, select, textarea, a, label'))
}

export function Packtisch({
  startDoc,
  onEnde,
  ansagen,
}: {
  /** Vom Scanfeld übergeben: die gescannte Lieferung, geladen. */
  startDoc?: PacktischDoc
  /** Zurück ans Scanfeld — mit dem nächsten Scan, falls einer kam. */
  onEnde?: (naechsterCode?: string) => void
  /** Sprachansage (Stimme wie „Sprechen"); false = keine Stimme → Piepton. */
  ansagen?: (schluessel: AnsageSchluessel) => boolean
} = {}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const gestartet = useRef(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [doc, setDoc] = useState<PacktischDoc | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [weightG, setWeightG] = useState<string>('')
  const [dhlProduct, setDhlProduct] = useState<string>('')
  const [labelLink, setLabelLink] = useState<string | null>(null)
  const [pruefend, setPruefend] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [flash, setFlash] = useState<'ok' | 'error' | null>(null)

  const refocus = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [])

  useEffect(() => {
    refocus()
  }, [refocus, phase])

  // Vom Scanfeld übergeben: direkt mit dem Packen beginnen — einmalig.
  useEffect(() => {
    if (startDoc && !gestartet.current) {
      gestartet.current = true
      uebernehmen(startDoc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDoc])

  const say = useCallback(
    (text: ReactNode, tone: Feedback['tone'], ansage?: AnsageSchluessel) => {
      setFeedback({ text, tone })
      // Gesprochen ersetzt den Piepton; ohne Stimme piept es wie bisher.
      const gesprochen = ansage ? (ansagen?.(ansage) ?? false) : false
      if (!gesprochen && tone !== 'info') playBeep(tone)
      setFlash(tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : null)
      setTimeout(() => setFlash(null), 350)
    },
    [ansagen],
  )

  const reset = useCallback(() => {
    // Im Scanfeld gibt es keinen eigenen Ruhezustand: zurück an den Dispatcher.
    if (onEnde) {
      onEnde()
      return
    }
    setPhase('idle')
    setDoc(null)
    setCounts({})
    setWeightG('')
    setDhlProduct('')
    setLabelLink(null)
    setFeedback(null)
    refocus()
  }, [refocus, onEnde])

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
      say(data.error ?? 'Lieferung nicht gefunden', 'error', ansageFuerFehler(data.error))
      return
    }
    uebernehmen(data as PacktischDoc)
  }

  function uebernehmen(loaded: PacktischDoc) {
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
      'lieferung',
    )
  }

  function scanProduct(code: string) {
    if (!doc) return
    // Beide Tastaturbelegungen (US-Scanner an deutschem Windows) — shared/scan.ts.
    const line = doc.lines.find((l) => scanGleich(code, l.barcode) || scanGleich(code, l.sku))
    if (!line) {
      say(
        <>
          &quot;<span className="mono">{code}</span>&quot; gehört nicht in dieses Paket
        </>,
        'error',
        'falscher_artikel',
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
        'schon_voll',
      )
      return
    }
    setCounts((c) => ({ ...c, [line.variantId]: current + 1 }))
    // Was gesagt wird, hängt am Stand NACH diesem Scan.
    const zeileVoll = current + 1 >= Number(line.qty)
    const allesVoll =
      zeileVoll &&
      doc.lines.every((l) => l.variantId === line.variantId || (counts[l.variantId] ?? 0) >= Number(l.qty))
    say(
      <>
        {line.product}:{' '}
        <span className="mono">
          {current + 1} / {line.qty}
        </span>
      </>,
      'ok',
      allesVoll ? 'label_bestaetigen' : zeileVoll ? 'zeile_voll' : 'passt',
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
        say(result.error, 'error', ansageFuerFehler(result.error))
        return
      }
      const link = result && 'link' in result ? (result.link ?? null) : null
      setLabelLink(link)
      setPhase('done')
      // Ein Link kommt nur, wenn KEIN Drucker am Platz druckt (0087) — dann
      // das Label sofort im Tab öffnen; Popup-Blocker fängt der Knopf
      // darunter ab. Druckt die Brücke, öffnet nichts (kein Doppeldruck).
      if (link) window.open(link, '_blank', 'noopener')
      const druckText = !link && result && 'info' in result ? result.info : null
      say(
        <>
          <span className="mono">{doc.number}</span> versandfertig —{' '}
          {druckText ?? 'Label bereit'}
        </>,
        'ok',
        'versandfertig',
      )
    } catch (err) {
      setPhase('confirm')
      say(err instanceof Error ? err.message : 'Abschluss fehlgeschlagen', 'error', 'fehler')
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
    const isDocCode = scanGleich(code, doc.number)
    if (phase === 'work') {
      if (isDocCode) {
        if (!complete) {
          say('Noch nicht alles im Paket — erst alle Positionen scannen', 'warn', 'nicht_komplett')
          return
        }
        setPhase('confirm')
        say('Alles im Paket — Versand-Code erneut scannen erstellt das Label', 'ok', 'label_bestaetigen')
      } else {
        scanProduct(code)
      }
      return
    }
    if (phase === 'confirm') {
      if (isDocCode) void book()
      else say('Zum Abschließen bitte den Versand-Code scannen', 'warn', 'label_bestaetigen')
      return
    }
    if (phase === 'done') {
      // Der nächste Zettel startet direkt den nächsten Vorgang — im
      // Scanfeld entscheidet wieder dessen Nummer (Paket, Eingang, MO).
      if (onEnde) {
        onEnde(code)
        return
      }
      reset()
      void loadDoc(code)
    }
  }

  // Vor dem Label (2026-10-01): DHL prüft die Sendung — mit Gewicht und
  // Produkt, wie sie gerade eingestellt sind — per validate=true, ohne Label.
  // Eine Beanstandung ist ein Hinweis an den Packer, kein Abbruch: er kann
  // die Adresse am Auftrag korrigieren oder bewusst weitermachen.
  async function adresseCheck() {
    if (!doc || pruefend) return
    setPruefend(true)
    const fd = new FormData()
    if (weightG && Number(weightG) > 0) fd.set('weight_g', weightG)
    if (dhlProduct) fd.set('dhl_product', dhlProduct)
    try {
      const result = await adressePruefen(doc.pickingId, fd)
      if (isActionError(result)) say(result.error, 'warn', 'fehler')
      else if (isActionInfo(result)) say(result.info, 'ok')
    } catch (err) {
      say(err instanceof Error ? err.message : 'Adressprüfung fehlgeschlagen', 'error', 'fehler')
    } finally {
      setPruefend(false)
      refocus()
    }
  }

  // Fehlendes Artikelgewicht direkt beim Packen setzen (2026-10-01): wird am
  // Artikel gespeichert; danach rechnet KRNL Paketgewicht und DHL-Produkt neu
  // (gescannte Mengen bleiben stehen).
  async function gewichtSpeichern(variantId: string, eingabe: string) {
    if (!doc) return
    const gramm = Math.round(Number(eingabe.replace(',', '.')))
    if (!Number.isFinite(gramm) || gramm < 1) {
      say('Gewicht in Gramm eingeben (mindestens 1)', 'warn')
      return
    }
    const fd = new FormData()
    fd.set('variant_id', variantId)
    fd.set('weight_g', String(gramm))
    const result = await artikelgewichtSetzen(fd)
    if (isActionError(result)) {
      say(result.error, 'error', 'fehler')
      return
    }
    const res = await fetch(`/api/packtisch/lookup?code=${encodeURIComponent(doc.number)}`)
    if (res.ok) {
      const neu = (await res.json()) as PacktischDoc
      setDoc((alt) => (alt ? { ...alt, lines: neu.lines, weightG: neu.weightG, dhlProduct: neu.dhlProduct } : alt))
      if (neu.weightG != null && neu.weightG > 0) setWeightG(String(neu.weightG))
      if (neu.dhlProduct) setDhlProduct(neu.dhlProduct)
    }
    say(`Gewicht gespeichert: ${gramm} g je Stück`, 'ok')
    refocus()
  }

  const adjust = (variantId: string, delta: number, max: number) => {
    setCounts((c) => ({
      ...c,
      [variantId]: Math.min(Math.max((c[variantId] ?? 0) + delta, 0), max),
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
        aria-label="Packtisch-Eingabe"
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
            scannen (<span className="mono">WH/OUT/…</span>).
          </p>
          {/* Tipp-Weg ohne Scanner: sichtbares Feld — nach dem Öffnen geht
              der Fokus zurück ans Scanfeld für die Artikel-Scans. */}
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
              placeholder="Liefer- oder Auftragsnummer"
              aria-label="Liefer- oder Auftragsnummer eintippen"
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
              {doc.kommissioniert && (
                <div className="small" style={{ color: 'var(--display-text)', marginTop: 4 }}>
                  <span className="led ok" /> kommissioniert
                  {doc.kommissioniert.von ? ` von ${doc.kommissioniert.von}` : ''} am{' '}
                  {new Date(doc.kommissioniert.am).toLocaleString('de-DE', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Europe/Berlin',
                  })}
                </div>
              )}
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
                  {!doc.labelVorhanden && phase !== 'done' && (
                    <button
                      className="small"
                      type="button"
                      onClick={() => void adresseCheck()}
                      disabled={pruefend || phase === 'booking'}
                      title="DHL prüft die Sendung samt Adresse, ohne ein Label zu erstellen"
                      style={{ marginTop: 4 }}
                    >
                      {pruefend ? 'Prüft…' : 'Adresse prüfen'}
                    </button>
                  )}
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
                    {Number(l.gewichtG) <= 0 && (
                      // Gewicht fehlt (aus Shopify nicht übernommen): hier setzen,
                      // sonst stimmen Paketgewicht und DHL-Produkt nicht.
                      <form
                        className="actions"
                        style={{ gap: 6, marginTop: 4 }}
                        onSubmit={(e) => {
                          e.preventDefault()
                          const feld = e.currentTarget.elements.namedItem('gramm') as HTMLInputElement
                          void gewichtSpeichern(l.variantId, feld.value)
                        }}
                      >
                        <span className="led warn" />
                        <span className="mono-label">Gewicht fehlt</span>
                        <input
                          name="gramm"
                          inputMode="numeric"
                          placeholder="g je Stück"
                          aria-label={`Gewicht von ${l.product} in Gramm`}
                          style={{ width: 96 }}
                        />
                        <button className="small" type="submit">
                          Speichern
                        </button>
                      </form>
                    )}
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
