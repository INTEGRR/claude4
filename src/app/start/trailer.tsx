'use client'

import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DAUER, KAPITEL, kapitelBei, masse, zeitText } from './trailer-logik'

/**
 * Der Trailer als Held der Startseite: ein Auftrag einmal durch KRNL —
 * Shop, Fertigung, Versand, Einkauf im Ausland, Prozessversion, Fragen —
 * und am Ende der Knopf zum Erstgespräch.
 *
 * Kein Video, sondern eine CSS-Zeitleiste: jede Animation hängt mit
 * absoluter Verzögerung an `.tr-laeuft` (Zeiten in start.css, Abschnitt
 * „Trailer"). Gesteuert wird über die Web Animations API — Pause, Kapitel
 * anspringen und Überspringen setzen nur `currentTime` aller Animationen
 * unter der Wurzel. Damit bleibt der Text scharf in jeder Größe, ist echter
 * Text (übersetzbar, durchsuchbar) und kostet keine Video-Bytes.
 *
 * Die Bühne hat eine feste logische Größe (16:9 oder hoch) und wird per
 * transform auf die Breite skaliert (`masse` in trailer-logik.ts). Wer
 * reduzierte Bewegung eingestellt hat, sieht sofort die Endkarte und
 * startet den Film nur auf Knopfdruck. Außerhalb des Sichtfelds und im
 * Hintergrund-Tab pausiert er.
 *
 * Alle Daten sind Demodaten; jede Behauptung muss das System wirklich
 * können (Sprachen de/en/zh, EZB-Kurse, Fracht und Zoll im Einstand,
 * Tracking-Mail über Shopify) — siehe docs/website.md.
 */

type Zustand = 'bereit' | 'spielt' | 'pausiert' | 'ende'

function animationen(wurzel: HTMLElement | null): CSSAnimation[] {
  if (!wurzel) return []
  return wurzel
    .getAnimations({ subtree: true })
    .filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName.startsWith('tr-'))
}

function uhr(wurzel: HTMLElement | null): number {
  const a = animationen(wurzel).find((x) => x.animationName === 'tr-zeit')
  return a ? Number(a.currentTime ?? 0) / 1000 : 0
}

/** Alle Animationen auf Sekunde `s`; `weiter` lässt die noch nicht beendeten laufen. */
function setzen(wurzel: HTMLElement | null, s: number, weiter: boolean) {
  const liste = animationen(wurzel)
  for (const a of liste) {
    a.pause()
    a.currentTime = s * 1000
  }
  if (!weiter) return
  for (const a of liste) {
    // play() auf einer beendeten Animation spult zurück — die bleiben stehen.
    const ende = Number(a.effect?.getComputedTiming().endTime ?? 0)
    if (s * 1000 < ende) a.play()
  }
}

const LED = (art: 'signal' | 'kern' | 'ok' | '' = '') => <i className={`tr-led${art ? ` ${art}` : ''}`} />

function Hexcore({ kontur, klasse }: { kontur: string; klasse?: string }) {
  return (
    <svg className={klasse} viewBox="0 0 100 100" fill="none" aria-hidden>
      <path className="tr-kontur" d="M50 6 L88 28 L88 72 L50 94 L12 72 L12 28 Z" stroke={kontur} strokeWidth="6" />
      <path d="M50 6 L88 28" stroke="#FF5A1F" strokeWidth="6" transform="translate(6,-3)" />
      <path d="M12 72 L50 94" stroke="#7C5AFF" strokeWidth="6" transform="translate(-5,3)" />
      <path d="M50 20 L50 42 M28 40 L42 50 M72 40 L58 50 M50 58 L50 78" stroke="#7C5AFF" strokeWidth="3" />
      <rect x="42" y="42" width="16" height="16" fill="#FF5A1F" />
    </svg>
  )
}

function v(werte: Record<string, string>): CSSProperties {
  return werte as CSSProperties
}

export function Trailer() {
  const wurzel = useRef<HTMLDivElement>(null)
  const rahmen = useRef<HTMLDivElement>(null)
  const buehne = useRef<HTMLDivElement>(null)
  const [format, setFormat] = useState<'quer' | 'hoch'>('quer')
  const [skaliert, setSkaliert] = useState(false)
  const [laeuft, setLaeuft] = useState(false)
  const [zustand, setZustand] = useState<Zustand>('bereit')
  const [sekunde, setSekunde] = useState(0)
  const [kapitel, setKapitel] = useState(-1)
  const ruhig = useRef(false)
  const autoPause = useRef(false)
  const zustandRef = useRef<Zustand>('bereit')
  zustandRef.current = zustand

  const anzeigen = useCallback((s: number) => {
    setSekunde(Math.floor(s))
    setKapitel(kapitelBei(s))
  }, [])

  // Größe: Breite messen, Format wählen, Bühne skalieren.
  useLayoutEffect(() => {
    const r = rahmen.current
    const b = buehne.current
    if (!r || !b) return
    const passen = () => {
      const m = masse(r.clientWidth, window.innerHeight)
      setFormat(m.format)
      r.style.height = `${m.hoehe}px`
      b.style.transform = `translateX(${m.links}px) scale(${m.skala})`
      setSkaliert(true)
    }
    passen()
    const ro = new ResizeObserver(passen)
    ro.observe(r)
    return () => ro.disconnect()
  }, [])

  // Start: nach den Schriften, sobald der Held zu sehen ist.
  useEffect(() => {
    ruhig.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let abgebrochen = false
    void document.fonts.ready.then(() => {
      if (!abgebrochen) setLaeuft(true)
    })
    return () => {
      abgebrochen = true
    }
  }, [])

  // Erst jetzt existieren die Animationen. Ruhig: gleich auf die Endkarte.
  useLayoutEffect(() => {
    if (!laeuft) return
    const r = rahmen.current
    const sichtbar = r ? r.getBoundingClientRect().top < window.innerHeight * 0.7 : true
    if (ruhig.current || !sichtbar) {
      setzen(wurzel.current, ruhig.current ? DAUER : 0, false)
      if (ruhig.current) {
        setZustand('ende')
        anzeigen(DAUER)
      } else {
        autoPause.current = true
        setZustand('pausiert')
      }
      return
    }
    setZustand('spielt')
  }, [laeuft, anzeigen])

  // Zeitanzeige und aktives Kapitel nachführen, solange er läuft.
  useEffect(() => {
    if (zustand !== 'spielt') return
    const t = window.setInterval(() => anzeigen(uhr(wurzel.current)), 200)
    return () => window.clearInterval(t)
  }, [zustand, anzeigen])

  const pausieren = useCallback((auto: boolean) => {
    if (zustandRef.current !== 'spielt') return
    const s = uhr(wurzel.current)
    setzen(wurzel.current, s, false)
    autoPause.current = auto
    anzeigen(s)
    setZustand('pausiert')
  }, [anzeigen])

  const fortsetzen = useCallback(() => {
    const s = uhr(wurzel.current)
    setzen(wurzel.current, s, true)
    autoPause.current = false
    setZustand('spielt')
  }, [])

  const springen = useCallback((s: number) => {
    setzen(wurzel.current, s, true)
    autoPause.current = false
    anzeigen(s)
    setZustand(s >= DAUER ? 'ende' : 'spielt')
  }, [anzeigen])

  // Außer Sicht oder im Hintergrund-Tab: anhalten, beim Zurückkommen weiter.
  useEffect(() => {
    const r = rahmen.current
    if (!r) return
    let imBild = true
    const pruefen = () => {
      const aktiv = imBild && document.visibilityState === 'visible'
      if (!aktiv) pausieren(true)
      else if (autoPause.current && zustandRef.current === 'pausiert') fortsetzen()
    }
    const io = new IntersectionObserver(
      ([e]) => {
        imBild = e.intersectionRatio >= 0.3
        pruefen()
      },
      { threshold: [0, 0.3, 0.6] },
    )
    io.observe(r)
    document.addEventListener('visibilitychange', pruefen)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', pruefen)
    }
  }, [pausieren, fortsetzen])

  const umschalten = () => {
    if (zustand === 'spielt') pausieren(false)
    else if (zustand === 'ende') springen(0)
    else if (zustand === 'pausiert') fortsetzen()
  }

  const ende = zustand === 'ende'

  return (
    <figure
      ref={wurzel}
      className={`tr-wurzel${laeuft ? ' tr-laeuft' : ''}`}
      data-zustand={zustand}
      aria-label="KRNL in 40 Sekunden: ein Auftrag vom Shop bis zum Lieferanten im Ausland"
    >
      <div
        ref={rahmen}
        className={`tr-rahmen${skaliert ? ' tr-skaliert' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a, button')) return
          umschalten()
        }}
      >
        <div ref={buehne} className={`tr-buehne tr-${format}`}>
          <div className="tr-bug" aria-hidden>
            <Hexcore kontur="#ededea" />
            <b>KRNL</b>
          </div>
          <div className="tr-demo tr-mono" aria-hidden>Demodaten</div>

          <div className="tr-szenen" aria-hidden>
            {/* 0 · Auftakt */}
            <div className="tr-szene tr-s0" style={v({ '--t': '0s', '--e': '4s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('signal')} Prozess-ERP · ein Auftrag, ein Tag</div>
                <div className="tr-titel">Ein Auftrag<em>.</em><br />Ein System<em>.</em></div>
                <div className="tr-unter">
                  Vom Shop über Fertigung und Versand bis zum Lieferanten im Ausland —
                  in einem Ablauf, den ihr bestimmt.
                </div>
              </div>
            </div>

            {/* 1 · Shop */}
            <div className="tr-szene tr-s1" style={v({ '--t': '4s', '--e': '9.5s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('signal')} 01 · Shop</div>
                <div className="tr-titel">Bestellung<br />rein<em>.</em></div>
                <div className="tr-unter">Shopify meldet, KRNL reserviert und stößt die Fertigung an — ohne Abtippen.</div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-bestellung">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('signal')} Shopify · neue Bestellung</span>
                    <span className="tr-mono">09:41</span>
                  </div>
                  <div className="tr-best-zeile"><span className="tr-best-nr">#5012</span><span className="tr-best-preis">189,00 €</span></div>
                  <div className="tr-artikel">
                    <svg width="190" height="78" viewBox="0 0 190 78" aria-hidden>
                      <defs>
                        <pattern id="tr-kappe" width="12" height="12" patternUnits="userSpaceOnUse">
                          <rect x="1" y="1" width="10" height="10" rx="2" fill="#3a3d42" />
                        </pattern>
                      </defs>
                      <rect x="1" y="1" width="188" height="76" rx="10" fill="#1d2024" stroke="#3a3d42" strokeWidth="2" />
                      <rect x="10" y="10" width="170" height="58" fill="url(#tr-kappe)" />
                      <rect x="34" y="58" width="72" height="9" rx="2" fill="#4a4d52" />
                      <rect x="166" y="10" width="11" height="11" rx="2" fill="#FF5A1F" />
                    </svg>
                    <div>
                      <div className="tr-art-name">NATIVE 75 · ISO-DE</div>
                      <div className="tr-art-sub">Schwarz · 1 Stück</div>
                    </div>
                  </div>
                  <div className="tr-kunde tr-mono">Lena K. · 10115 Berlin</div>
                  <div className="tr-chips">
                    <span className="tr-chip" style={v({ '--d': '5.2s' })}>{LED('ok')}bezahlt</span>
                    <span className="tr-chip" style={v({ '--d': '5.9s' })}>{LED('ok')}reserviert</span>
                    <span className="tr-chip" style={v({ '--d': '6.6s' })}>{LED('kern')}Fertigung angestoßen</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 2 · Fertigung */}
            <div className="tr-szene tr-s2" style={v({ '--t': '9.5s', '--e': '15s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('kern')} 02 · Fertigung</div>
                <div className="tr-titel">Fertigung<br />zieht mit<em>.</em></div>
                <div className="tr-unter">Auftrag, Material, baubare Menge — der Shop zeigt live, was ihr bauen könnt.</div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-fertigung">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('kern')} Fertigungsauftrag</span>
                    <span className="tr-mono">FA/0418</span>
                  </div>
                  <div className="tr-fa-titel">NATIVE 75 · ISO-DE · Schwarz</div>
                  <div className="tr-fortschritt"><i /></div>
                  <ul className="tr-material">
                    <li><i className="tr-led" style={v({ '--d': '10.4s' })} />PCB Hot-Swap ISO<span>reserviert</span></li>
                    <li><i className="tr-led" style={v({ '--d': '10.8s' })} />Gehäuse Alu Schwarz<span>reserviert</span></li>
                    <li><i className="tr-led" style={v({ '--d': '11.2s' })} />84× Switch Linear<span>reserviert</span></li>
                  </ul>
                </div>
                <div className="tr-anzeige tr-baubar">
                  <div className="tr-mono">Baubar · Shop-Bestand</div>
                  <div className="tr-seg"><span className="tr-geist">88</span><span className="tr-w tr-w1">24</span><span className="tr-w tr-w2">23</span></div>
                  <div className="tr-mono tr-gemeldet">{LED('ok')} an Shopify gemeldet</div>
                </div>
              </div>
            </div>

            {/* 3 · Versand */}
            <div className="tr-szene tr-s3" style={v({ '--t': '15s', '--e': '20.5s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('signal')} 03 · Versand</div>
                <div className="tr-titel">Ein Scan<em>.</em><br />Label raus<em>.</em></div>
                <div className="tr-unter">DHL-Label, Ausbuchung, Tracking an Shopify — die Versandmail schickt der Shop.</div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-scan">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('signal')} Packtisch · Scan</span>
                    <span className="tr-mono">LF/00912</span>
                  </div>
                  <div className="tr-barcode"><div className="tr-laser" /><div className="tr-blitz" /></div>
                  <div className="tr-scan-nr tr-mono"><span>1 × NATIVE 75</span><span>2,1 kg</span></div>
                </div>
                <div className="tr-anzeige tr-drucker">
                  <div className="tr-label">
                    <div className="tr-dhl">DHL Paket <span>V01PAK</span></div>
                    <div className="tr-adr">Lena K.<br />Musterstraße 12<br />10115 Berlin</div>
                    <div className="tr-code" />
                    <div className="tr-tn">00340434 6620 1857 39</div>
                  </div>
                </div>
                <span className="tr-chip tr-versendet">{LED('ok')}Versendet · Tracking an Shopify</span>
              </div>
            </div>

            {/* 4 · Einkauf im Ausland */}
            <div className="tr-szene tr-s4" style={v({ '--t': '20.5s', '--e': '28s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('kern')} 04 · Einkauf</div>
                <div className="tr-titel">Einkauf im<br />Ausland<em>?</em></div>
                <div className="tr-unter">
                  Vier Länder, drei Sprachen, drei Währungen — verglichen in Euro,
                  mit Fracht und Zoll.
                </div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-postfach">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('kern')} Einkaufspostfach · EP/00007</span>
                    <span className="tr-mono">4 Angebote</span>
                  </div>
                  <div className="tr-post" style={v({ '--d': '20.9s' })}>
                    <span className="tr-land">CN</span>
                    <div className="tr-post-text">
                      <b>Shenzhen Keyworks</b>
                      <span className="tr-uebersetzung">
                        <span className="tr-zh">您好！2000 件，单价 4.90 元，交期 25 天。</span>
                        <span className="tr-de">Hallo! 2.000 Stück à 4,90 CNY, Lieferzeit 25 Tage.</span>
                      </span>
                    </div>
                    <span className="tr-sprache tr-mono tr-uebersetzt">中文 → DE</span>
                  </div>
                  <div className="tr-post" style={v({ '--d': '21.2s' })}>
                    <span className="tr-land">PL</span>
                    <div className="tr-post-text"><b>Kraków Precision</b><span>Angebot: 2.000 Stk. à 2,95 PLN, DAP.</span></div>
                    <span className="tr-sprache tr-mono">DE</span>
                  </div>
                  <div className="tr-post" style={v({ '--d': '21.5s' })}>
                    <span className="tr-land">VN</span>
                    <div className="tr-post-text"><b>Hai Phong Molding</b><span>Quote: 2,000 pcs at USD 0.66, FOB.</span></div>
                    <span className="tr-sprache tr-mono">EN</span>
                  </div>
                  <div className="tr-post" style={v({ '--d': '21.8s' })}>
                    <span className="tr-land">US</span>
                    <div className="tr-post-text"><b>Austin Switch Co.</b><span>USD 0.71 per piece, EXW, air freight.</span></div>
                    <span className="tr-sprache tr-mono">EN</span>
                  </div>
                </div>
                <div className="tr-anzeige tr-vergleich">
                  <div className="tr-mono tr-vergleich-kopf">Einstand je Stück · Ware + Fracht + Zoll · EZB-Kurs</div>
                  <div className="tr-zeile tr-beste">
                    <span>Shenzhen Keyworks <small>CN · CNY</small></span>
                    <i className="tr-bar" style={v({ '--b': '0.6', '--d': '23.9s' })} />
                    <span className="tr-wert">0,69 €</span>
                  </div>
                  <div className="tr-zeile">
                    <span>Kraków Precision <small>PL · PLN</small></span>
                    <i className="tr-bar" style={v({ '--b': '0.65', '--d': '24.05s' })} />
                    <span className="tr-wert">0,71 €</span>
                  </div>
                  <div className="tr-zeile">
                    <span>Hai Phong Molding <small>VN · USD</small></span>
                    <i className="tr-bar" style={v({ '--b': '0.7', '--d': '24.2s' })} />
                    <span className="tr-wert">0,74 €</span>
                  </div>
                  <div className="tr-zeile">
                    <span>Austin Switch Co. <small>US · USD</small></span>
                    <i className="tr-bar" style={v({ '--b': '0.86', '--d': '24.35s' })} />
                    <span className="tr-wert">0,86 €</span>
                  </div>
                  <div className="tr-mono tr-badge">{LED('signal')} Günstigster Einstand · Anfrage in Lieferantensprache</div>
                </div>
              </div>
            </div>

            {/* 5 · Prozess */}
            <div className="tr-szene tr-s5" style={v({ '--t': '28s', '--e': '33.5s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('kern')} 05 · Prozess</div>
                <div className="tr-titel">Euer Ablauf<em>.</em><br />Eure Regeln<em>.</em></div>
                <div className="tr-unter">Neuer Prüfschritt? Version entwerfen, schalten — am selben Tag live, ohne Release.</div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-prozess">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('kern')} Prozess · Auftragsdurchlauf</span>
                    <span className="tr-mono tr-status">
                      <span className="tr-status-a">v1.4 · aktiv</span>
                      <span className="tr-status-b">v1.5 · Entwurf</span>
                      <span className="tr-status-c">v1.5 · geschaltet</span>
                    </span>
                  </div>
                  <ol className="tr-schritte">
                    <li><b className="tr-pkt" /><span className="tr-mono">Auslöser</span>Bestellung erfasst</li>
                    <li><b className="tr-pkt" /><span className="tr-mono">Schritt</span>Kommissionieren</li>
                    <li><b className="tr-pkt" /><span className="tr-mono">Schritt</span>Packen</li>
                    <li className="tr-neu"><b className="tr-pkt" /><span className="tr-mono">Neu</span>Qualitätscheck</li>
                    <li><b className="tr-pkt" /><span className="tr-mono">Abschluss</span>Versand gemeldet</li>
                  </ol>
                  <div className="tr-prozess-fuss">
                    <span className="tr-mono tr-live">{LED('ok')} live · ohne Release</span>
                    <span className="tr-schalten">Version schalten</span>
                  </div>
                  <svg className="tr-zeiger" width="44" height="56" viewBox="0 0 22 28" aria-hidden>
                    <path d="M1 1 L1 22 L6.5 17 L10.5 26.5 L14 25 L10 15.8 L17.5 15.5 Z" fill="#fff" stroke="#0b0c0e" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            </div>

            {/* 6 · KI */}
            <div className="tr-szene tr-s6" style={v({ '--t': '33.5s', '--e': '38.6s' })}>
              <div className="tr-kopf">
                <div className="tr-kicker tr-mono">{LED('signal')} 06 · KI</div>
                <div className="tr-titel">Fragen statt<br />suchen<em>.</em></div>
                <div className="tr-unter">Sprecht mit eurem ERP — gebucht wird erst nach eurer Bestätigung.</div>
              </div>
              <div className="tr-bild">
                <div className="tr-anzeige tr-ki">
                  <div className="tr-anz-kopf">
                    <span className="tr-mono">{LED('signal')} Sprechen</span>
                    <span className="tr-mono">KRNL</span>
                  </div>
                  <div className="tr-frage">
                    <div className="tr-welle">
                      {[['52px', '0s'], ['66px', '0.06s'], ['40px', '0.12s'], ['60px', '0.03s'], ['34px', '0.09s'], ['56px', '0.15s']].map(([h, w]) => (
                        <i key={w} style={v({ '--h': h, '--w': w })} />
                      ))}
                    </div>
                    <span className="tr-frage-text">„Was ist heute fällig?"</span>
                  </div>
                  <ul className="tr-antwort">
                    <li style={v({ '--d': '35.1s' })}>{LED('ok')}3 Pakete raus<span>bis 15 Uhr</span></li>
                    <li style={v({ '--d': '35.45s' })}>{LED('kern')}FA/0418 fertig melden<span>Fertigung</span></li>
                    <li style={v({ '--d': '35.8s' })}>{LED('signal')}Anzahlung Keyworks<span>2.940 CNY</span></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Endkarte auf Papier */}
          <div className="tr-wisch" aria-hidden />
          <div className="tr-szene tr-ende">
            <div className="tr-logo" aria-hidden>
              <Hexcore kontur="#1a1b1d" />
              <span className="tr-wort">KRNL</span>
            </div>
            <div className="tr-claim">
              Das ERP richtet sich nach eurem Prozess.<em>Nicht umgekehrt.</em>
            </div>
            <div className="tr-ende-knoepfe">
              <a className="tr-cta" href="#anmelden" tabIndex={ende ? 0 : -1}>Erstgespräch anfragen →</a>
              <button type="button" className="tr-nochmal" tabIndex={ende ? 0 : -1} onClick={() => springen(0)}>
                Nochmal ansehen ↺
              </button>
            </div>
            <div className="tr-fuss tr-mono">Prozess-ERP · deutsch · eigene Instanz</div>
          </div>
        </div>
      </div>

      {/* Steuerleiste: Kapitel sind zugleich der Fortschritt */}
      <div className="tr-steuerung">
        <div className="tr-zeit" aria-hidden><i onAnimationEnd={(e) => {
          if (e.animationName === 'tr-zeit') {
            setZustand('ende')
            anzeigen(DAUER)
          }
        }} /></div>
        <button
          type="button"
          className="tr-taste tr-spielen"
          onClick={umschalten}
          disabled={zustand === 'bereit'}
          aria-label={zustand === 'spielt' ? 'Pause' : ende ? 'Nochmal abspielen' : 'Abspielen'}
        >
          {zustand === 'spielt' ? (
            <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : ende ? (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M8 2.5a5.5 5.5 0 1 1-5.2 3.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M1.6 2.2 L3.2 6.6 L7.4 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.2 L13.5 8 L4 13.8 Z" /></svg>
          )}
        </button>
        <div className="tr-faden" role="group" aria-label="Kapitel">
          <div className="tr-faden-linie"><i /></div>
          {KAPITEL.map((k, i) => (
            <button
              key={k.name}
              type="button"
              className="tr-kapitel"
              style={v({ '--k': `${k.t}s`, '--x': `${(i / (KAPITEL.length - 1)) * 100}%` })}
              aria-current={kapitel === i ? 'step' : undefined}
              disabled={zustand === 'bereit'}
              onClick={() => springen(k.t)}
            >
              <b /><span>{k.name}</span>
            </button>
          ))}
        </div>
        <span className="tr-zeitangabe" aria-hidden>{zeitText(sekunde)} / {zeitText(DAUER)}</span>
        <button
          type="button"
          className="tr-taste tr-weiter"
          onClick={() => springen(ende ? 0 : DAUER)}
          disabled={zustand === 'bereit'}
        >
          {ende ? 'Nochmal' : 'Überspringen'}
        </button>
      </div>
    </figure>
  )
}
