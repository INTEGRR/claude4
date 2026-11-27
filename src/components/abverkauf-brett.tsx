'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type ActionResult, isActionError } from '@/modules/shared/action'
import type { AbverkaufStand } from '@/modules/verkauf/abverkauf'
import { FENSTER, type Fenster, type TeilZeile, dauerText } from '@/modules/verkauf/abverkauf-logik'
import { Zahl, useAenderungen } from './montage-brett'

/**
 * Abverkauf (0144): das Command Center für den Release-Tag. Fragt alle vier
 * Sekunden den Stand ab. Oben, was gerade läuft; in der Mitte das Ranking
 * der Teile — ganz oben steht, was als Nächstes ausgeht. Jede Zeile hat den
 * Knopf „Ausverkauft setzen": das Teil zählt dann für den Shop als 0, und
 * damit alles, was es in der Stückliste hat.
 */

const TAKT_MS = 4000
/** So viele Plätze zeigt das Ranking, bevor „alle zeigen" nötig wird. */
const PLAETZE = 10

function prognose(t: TeilZeile): string {
  if (t.zustand === 'gesperrt') return 'von Hand ausverkauft gesetzt'
  if (t.zustand === 'ueberverkauft') return `überverkauft um ${t.fehlt.toLocaleString('de-DE')}`
  if (t.zustand === 'leer') return 'ausverkauft'
  if (t.minuten === null) return 'kein Abverkauf'
  return `leer in ${dauerText(t.minuten)}`
}

function Zeile({
  t,
  puls,
  darf,
  schalten,
}: {
  t: TeilZeile
  puls?: 'mehr' | 'weniger'
  darf: boolean
  schalten: (t: TeilZeile, sperren: boolean) => Promise<string | null>
}) {
  const [frage, setFrage] = useState(false)
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const sperren = t.zustand !== 'gesperrt'

  async function ausfuehren() {
    setLaeuft(true)
    setFehler(await schalten(t, sperren))
    setLaeuft(false)
    setFrage(false)
  }

  return (
    <li className={`abv-zeile ${t.zustand}${puls ? ` puls-${puls}` : ''}`}>
      <span className="abv-rang" aria-label={t.rang ? `Platz ${t.rang}` : undefined}>{t.rang ?? '–'}</span>
      <div className="abv-teil">
        <span className="abv-name" title={t.name}>{t.name}</span>
        <span className="abv-neben">
          in {t.artikel.toLocaleString('de-DE')} {t.artikel === 1 ? 'Produkt' : 'Produkten'}
          {t.je !== 1 && <> · {t.je.toLocaleString('de-DE')} je Tastatur</>}
          {t.sku && <> · {t.sku}</>}
        </span>
        <span className="abv-balken" aria-hidden="true">
          <span style={{ width: `${Math.round(t.anteil * 100)}%` }} />
        </span>
      </div>
      <div className="abv-reicht">
        <Zahl wert={t.reicht} />
        <span className="abv-klein">reicht für</span>
      </div>
      <div className="abv-tempo">
        <span><strong>{t.verkauft.toLocaleString('de-DE')}</strong> verkauft</span>
        <span>{t.tempo > 0 ? <><strong>{t.tempo.toLocaleString('de-DE')}</strong> je Std</> : 'kein Tempo'}</span>
      </div>
      <div className="abv-prognose" role="status">{prognose(t)}</div>
      {darf && (
        <div className="abv-knopf">
          {frage ? (
            <>
              <button type="button" className={sperren ? 'small danger' : 'small'} disabled={laeuft} onClick={ausfuehren}>
                {laeuft ? '…' : sperren ? 'Ja, auf 0' : 'Ja, freigeben'}
              </button>
              <button type="button" className="small" disabled={laeuft} onClick={() => setFrage(false)}>Nein</button>
            </>
          ) : (
            <button type="button" className={sperren ? 'small danger' : 'small'} onClick={() => setFrage(true)}>
              {sperren ? 'Ausverkauft setzen' : 'Freigeben'}
            </button>
          )}
        </div>
      )}
      {frage && (
        <p className="abv-frage">
          {sperren
            ? `„${t.name}" zählt dann für den Shop als 0 — ${t.artikel === 1 ? 'das Produkt' : `alle ${t.artikel} Produkte`} mit diesem Teil in der Stückliste ${t.artikel === 1 ? 'geht' : 'gehen'} in jeder Variante, die es braucht, auf ausverkauft.`
            : `„${t.name}" zählt wieder mit seinem Bestand — die Varianten mit diesem Teil kommen zurück in den Verkauf.`}
        </p>
      )}
      {fehler && <p className="abv-frage fehler">{fehler}</p>}
    </li>
  )
}

export function AbverkaufBrett({
  anfang,
  darf,
  teilSperren,
}: {
  anfang: AbverkaufStand
  darf: boolean
  teilSperren: (variantId: string, gesperrt: boolean) => Promise<ActionResult>
}) {
  const [stand, setStand] = useState(anfang)
  const [fenster, setFenster] = useState<Fenster>(anfang.fenster)
  const [projekt, setProjekt] = useState<string | null>(anfang.projekt)
  const [fehler, setFehler] = useState<string | null>(null)
  const [alter, setAlter] = useState(0)
  const [alle, setAlle] = useState(false)
  const brett = useRef<HTMLDivElement>(null)

  const laden = useCallback(async () => {
    try {
      const q = new URLSearchParams({ fenster })
      if (projekt) q.set('projekt', projekt)
      const r = await fetch(`/api/abverkauf?${q}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(r.status === 401 ? 'Abgemeldet — bitte neu anmelden' : `Fehler ${r.status}`)
      setStand((await r.json()) as AbverkaufStand)
      setFehler(null)
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Keine Verbindung')
    }
  }, [fenster, projekt])

  useEffect(() => {
    void laden()
    const takt = setInterval(() => { if (!document.hidden) void laden() }, TAKT_MS)
    const sichtbar = () => { if (!document.hidden) void laden() }
    document.addEventListener('visibilitychange', sichtbar)
    // Auswahl in der Adresse halten — ein Neuladen zeigt dieselbe Sicht.
    const q = new URLSearchParams()
    if (fenster !== 'heute') q.set('fenster', fenster)
    if (projekt) q.set('projekt', projekt)
    window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`)
    return () => {
      clearInterval(takt)
      document.removeEventListener('visibilitychange', sichtbar)
    }
  }, [laden, fenster, projekt])

  useEffect(() => {
    const t = setInterval(() => setAlter(Math.max(0, Math.round((Date.now() - new Date(stand.stand).getTime()) / 1000))), 1000)
    return () => clearInterval(t)
  }, [stand.stand])

  async function schalten(t: TeilZeile, sperren: boolean): Promise<string | null> {
    try {
      const r = await teilSperren(t.id, sperren)
      if (isActionError(r)) return r.error
      await laden()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'Aktion fehlgeschlagen'
    }
  }

  const werte = new Map<string, number>(stand.teile.map((t) => [t.id, t.reicht]))
  werte.set('#stueck', stand.stueck).set('#bestellungen', stand.bestellungen)
  const puls = useAenderungen(werte)
  const veraltet = fehler !== null || alter > 20

  const rang = stand.teile.filter((t) => t.rang !== null)
  const leer = stand.teile.filter((t) => t.zustand === 'leer')
  const gesperrt = stand.teile.filter((t) => t.zustand === 'gesperrt')
  const naechster = rang.find((t) => t.zustand === 'ueberverkauft' || t.minuten !== null) ?? null
  const sichtbar = alle ? rang : rang.slice(0, PLAETZE)
  const maxVerlauf = Math.max(1, ...stand.verlauf)
  const fensterText = FENSTER.find((f) => f.wert === stand.fenster)?.label ?? 'heute'

  return (
    <div ref={brett} className="montage-brett abv-brett">
      <div className="abv-leiste">
        <div className="abv-wahl" role="group" aria-label="Zeitfenster">
          {FENSTER.map((f) => (
            <button key={f.wert} type="button" className="small" aria-pressed={fenster === f.wert} onClick={() => setFenster(f.wert)}>
              {f.label}
            </button>
          ))}
        </div>
        {stand.projekte.length > 1 && (
          <div className="abv-wahl" role="group" aria-label="Shop-Projekt">
            <button type="button" className="small" aria-pressed={projekt === null} onClick={() => setProjekt(null)}>alle</button>
            {stand.projekte.map((p) => (
              <button key={p} type="button" className="small" aria-pressed={projekt === p} onClick={() => setProjekt(p)}>{p}</button>
            ))}
          </div>
        )}
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

      {stand.shopify !== 'schreiben' && (
        <p className="abv-hinweis">
          Shopify steht auf „{stand.shopify === 'probe' ? 'Probelauf' : 'nur lesen'}" — „Ausverkauft setzen" wirkt in KRNL, an den Shop geht nichts hinaus.
        </p>
      )}

      <div className="montage-kopf">
        <div className={`montage-gesamt${puls.get('#stueck') ? ` puls-${puls.get('#stueck')}` : ''}`}>
          <span className="montage-kopf-titel">Tastaturen verkauft · {fensterText}</span>
          <Zahl wert={stand.stueck} />
          <span className="montage-kopf-neben">
            in {stand.bestellungen.toLocaleString('de-DE')} {stand.bestellungen === 1 ? 'Bestellung' : 'Bestellungen'}
          </span>
        </div>
        <div className="montage-gesamt">
          <span className="montage-kopf-titel">Tempo · letzte 15 Min</span>
          <Zahl wert={Math.round(stand.tempo)} />
          <span className="montage-kopf-neben">Tastaturen je Stunde</span>
          <span className="abv-verlauf" aria-label="Verkäufe je 5 Minuten, letzte Stunde">
            {stand.verlauf.map((v, i) => (
              // Feste Reihenfolge: zwölf Zeitscheiben, älteste links.
              // eslint-disable-next-line react/no-array-index-key
              <span key={i} style={{ height: `${Math.max(6, (v / maxVerlauf) * 100)}%` }} className={v > 0 ? 'an' : undefined} title={`${v} Stück`} />
            ))}
          </span>
        </div>
        <div className={`montage-gesamt abv-naechster ${naechster?.zustand ?? ''}`}>
          <span className="montage-kopf-titel">Geht als Nächstes aus</span>
          {naechster ? (
            <>
              <span className="abv-naechster-name">{naechster.name}</span>
              <span className="montage-kopf-neben">
                {naechster.zustand === 'ueberverkauft'
                  ? `überverkauft um ${naechster.fehlt.toLocaleString('de-DE')}`
                  : `reicht für ${naechster.reicht.toLocaleString('de-DE')} · ${prognose(naechster)}`}
              </span>
            </>
          ) : (
            <>
              <span className="abv-naechster-name ruhig">nichts in Sicht</span>
              <span className="montage-kopf-neben">kein Teil läuft bei diesem Tempo leer</span>
            </>
          )}
        </div>
      </div>

      <div className="abv-raster">
        <section className="abv-karte">
          <header>
            <h2>Was zuerst ausgeht</h2>
            <span className="abv-klein">Reichweite in Tastaturen · oben steht, was am schnellsten auf 0 läuft</span>
          </header>
          {rang.length === 0 ? (
            <p className="montage-leer">Kein Teil mit Bestand — nichts läuft gerade ab.</p>
          ) : (
            <ol className="abv-liste">
              {sichtbar.map((t) => (
                <Zeile key={t.id} t={t} puls={puls.get(t.id)} darf={darf} schalten={schalten} />
              ))}
            </ol>
          )}
          {rang.length > PLAETZE && (
            <button type="button" className="small abv-mehr" onClick={() => setAlle(!alle)}>
              {alle ? 'Nur die ersten zeigen' : `Alle ${rang.length} Teile zeigen`}
            </button>
          )}
          {gesperrt.length > 0 && (
            <>
              <h3>Von Hand ausverkauft gesetzt</h3>
              <ol className="abv-liste">
                {gesperrt.map((t) => <Zeile key={t.id} t={t} darf={darf} schalten={schalten} />)}
              </ol>
            </>
          )}
          {leer.length > 0 && (
            <details className="abv-leer">
              <summary>Schon ausverkauft ({leer.length})</summary>
              <ol className="abv-liste">
                {leer.map((t) => <Zeile key={t.id} t={t} darf={darf} schalten={schalten} />)}
              </ol>
            </details>
          )}
        </section>

        <div className="abv-seite">
          {stand.auflagen.map((a) => {
            const gesamt = a.bis - a.von + 1
            const voll = a.vergeben >= gesamt
            return (
              <section key={a.id} className="abv-karte">
                <header>
                  <h2>{a.name}</h2>
                  <Link href={`/verkauf/auflagen?auflage=${a.id}`} className="small">Liste</Link>
                </header>
                <p className="abv-auflage">
                  <Zahl wert={a.vergeben} /> <span>von {gesamt.toLocaleString('de-DE')} Nummern vergeben</span>
                </p>
                <span className="abv-balken gross" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.round((a.vergeben / gesamt) * 100))}%` }} />
                </span>
                {a.letzte.length > 0 && (
                  <p className="abv-klein">
                    Zuletzt: {a.letzte.map((l) => `Nr. ${l.nummer} → ${l.bestellung}`).join(' · ')}
                  </p>
                )}
                {a.ohneNummer > 0 && (
                  <p className={`abv-klein ${voll ? 'warn' : ''}`}>
                    {voll
                      ? `Auflage voll — ${a.ohneNummer.toLocaleString('de-DE')} verkaufte Stück ohne Nummer.`
                      : `${a.ohneNummer.toLocaleString('de-DE')} Stück warten auf ihre Nummer (kommt innerhalb von zwei Minuten).`}
                  </p>
                )}
              </section>
            )
          })}

          <section className="abv-karte">
            <header><h2>Was läuft</h2><span className="abv-klein">{fensterText}</span></header>
            {stand.artikel.length === 0 ? (
              <p className="abv-klein">Noch keine Bestellung in diesem Zeitfenster.</p>
            ) : (
              <ul className="abv-renner">
                {stand.artikel.map((a) => (
                  <li key={a.id}>
                    <span className="abv-renner-name" title={a.name}>{a.name}</span>
                    <span className="abv-balken" aria-hidden="true"><span style={{ width: `${Math.max(3, a.anteil * 100)}%` }} /></span>
                    <strong>{a.menge.toLocaleString('de-DE')}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {stand.optionen.length > 0 && (
            <section className="abv-karte">
              <header><h2>Beliebteste Optionen</h2><span className="abv-klein">{fensterText}</span></header>
              <ul className="abv-renner">
                {stand.optionen.map((o) => (
                  <li key={`${o.option}|${o.wert}`}>
                    <span className="abv-renner-name" title={`${o.option}: ${o.wert}`}>
                      <span className="abv-klein">{o.option}</span> {o.wert}
                    </span>
                    <span className="abv-balken" aria-hidden="true"><span style={{ width: `${Math.max(3, o.anteil * 100)}%` }} /></span>
                    <strong>{o.menge.toLocaleString('de-DE')}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
