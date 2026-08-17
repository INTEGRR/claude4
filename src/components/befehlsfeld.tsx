'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MikrofonKnopf, SendenSymbol } from './spracheingabe'

/**
 * Das Befehlsfeld der Daily Routine: EIN Feld, in dem man sagt, was man tun
 * will. Aktionen und Seiten matchen sofort und lokal (ohne KI-Latenz — die
 * Masken sind aus den Registry-Schemas generiert und stehen in
 * Millisekunden), Belege kommen per Suche nach, und wenn nichts passt,
 * übernimmt die KI den Freitext. Was der Benutzer oft nutzt, rückt im
 * Ranking nach vorn (nutzungs_zaehler).
 */

export interface BefehlsAktion {
  name: string
  label: string
  bereich: string
}

export interface BefehlsSeite {
  href: string
  label: string
}

interface Treffer {
  gruppe: 'Häufig' | 'Aktionen' | 'Seiten' | 'Belege' | 'KI'
  label: string
  hinweis: string
  ziel: string
  /** Nutzungszählung beim Öffnen (nur Seiten — Aktionen zählt der Torwächter). */
  zaehlen?: string
  /** Aktion am Beleg („P01670 freigeben"): ohne Felder direkt ausführbar. */
  aktion?: { name: string; recordId: string; felderNoetig: boolean }
}

function rang(text: string, q: string): number {
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 3
  if (t.split(/\s|·/).some((w) => w.startsWith(q))) return 2
  if (t.includes(q)) return 1
  return 0
}

export function Befehlsfeld({
  aktionen,
  seiten,
  gewichte,
  gross = false,
  autoFokus = false,
  onNavigiert,
}: {
  aktionen: BefehlsAktion[]
  seiten: BefehlsSeite[]
  /** Nutzungshäufigkeit je Schlüssel (Aktion-Name bzw. Seiten-Pfad). */
  gewichte: Record<string, number>
  gross?: boolean
  autoFokus?: boolean
  /** Im Overlay: schließt den Dialog, sobald ein Treffer geöffnet wurde. */
  onNavigiert?: () => void
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [belege, setBelege] = useState<Treffer[]>([])
  const [aktiv, setAktiv] = useState(0)
  const [fokus, setFokus] = useState(false)
  const [meldung, setMeldung] = useState<string | null>(null)
  const feld = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFokus) feld.current?.focus()
  }, [autoFokus])

  // Belegsuche nachgelagert und entprellt — die lokalen Treffer stehen sofort.
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) {
      setBelege([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suche?q=${encodeURIComponent(text)}`)
        const daten = (await res.json()) as {
          treffer?: {
            label: string
            hinweis: string
            link: string
            aktion?: { name: string; record_id: string; felder_noetig: boolean }
          }[]
        }
        setBelege(
          (daten.treffer ?? []).map((t) => ({
            gruppe: 'Belege',
            label: t.label,
            hinweis: t.hinweis,
            ziel: t.link,
            ...(t.aktion
              ? {
                  aktion: {
                    name: t.aktion.name,
                    recordId: t.aktion.record_id,
                    felderNoetig: t.aktion.felder_noetig,
                  },
                }
              : {}),
          })),
        )
      } catch {
        setBelege([])
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [q])

  const treffer = useMemo<Treffer[]>(() => {
    const text = q.trim().toLowerCase()
    const gewicht = (schluessel: string) => gewichte[schluessel] ?? 0

    if (!text) {
      // Leeres Feld: das eigene Gedächtnis — was hier oft benutzt wird.
      const haeufig: Treffer[] = [
        ...aktionen
          .filter((a) => gewicht(a.name) > 0)
          .map((a) => ({
            gruppe: 'Häufig' as const,
            label: a.label,
            hinweis: a.bereich,
            ziel: `/aktion/${encodeURIComponent(a.name)}`,
            sortier: gewicht(a.name),
          })),
        ...seiten
          .filter((s) => gewicht(s.href) > 0)
          .map((s) => ({
            gruppe: 'Häufig' as const,
            label: s.label,
            hinweis: 'Seite',
            ziel: s.href,
            zaehlen: s.href,
            sortier: gewicht(s.href),
          })),
      ]
        .sort((a, b) => b.sortier - a.sortier)
        .slice(0, 7)
      return haeufig
    }

    const aktionsTreffer = aktionen
      .map((a) => ({ a, r: rang(`${a.label} ${a.name} ${a.bereich}`, text) }))
      .filter(({ r }) => r > 0)
      .sort((x, y) => y.r - x.r || gewicht(y.a.name) - gewicht(x.a.name))
      .slice(0, 6)
      .map(({ a }) => ({
        gruppe: 'Aktionen' as const,
        label: a.label,
        hinweis: a.bereich,
        ziel: `/aktion/${encodeURIComponent(a.name)}`,
      }))

    const seitenTreffer = seiten
      .map((s) => ({ s, r: rang(s.label, text) }))
      .filter(({ r }) => r > 0)
      .sort((x, y) => y.r - x.r || gewicht(y.s.href) - gewicht(x.s.href))
      .slice(0, 4)
      .map(({ s }) => ({
        gruppe: 'Seiten' as const,
        label: s.label,
        hinweis: 'Seite',
        ziel: s.href,
        zaehlen: s.href,
      }))

    return [
      ...aktionsTreffer,
      ...seitenTreffer,
      ...belege,
      {
        gruppe: 'KI' as const,
        label: `KI fragen: „${q.trim()}"`,
        hinweis: 'Freitext an den Agenten',
        ziel: `/ki?frage=${encodeURIComponent(q.trim())}`,
      },
    ]
  }, [q, aktionen, seiten, belege, gewichte])

  function oeffnen(t: Treffer) {
    if (t.zaehlen) {
      void fetch('/api/nutzung', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schluessel: t.zaehlen }),
      }).catch(() => undefined)
    }
    // Beleg + Aktion in einem Zug: parameterlose Schritte laufen nach
    // Rückfrage direkt (Torwächter prüft ohnehin); mit Feldern geht es zur
    // Belegseite, wo das Formular wartet.
    if (t.aktion && !t.aktion.felderNoetig) {
      if (!window.confirm(`${t.label} — jetzt ausführen?`)) return
      void (async () => {
        try {
          const res = await fetch(`/api/aktion/${encodeURIComponent(t.aktion!.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ record_id: t.aktion!.recordId }),
          })
          const daten = (await res.json().catch(() => ({}))) as { error?: string; info?: string }
          if (!res.ok || daten.error) {
            setMeldung(daten.error ?? `Aktion fehlgeschlagen (${res.status})`)
            return
          }
          setQ('')
          setFokus(false)
          onNavigiert?.()
          router.push(t.ziel)
          router.refresh()
        } catch {
          setMeldung('Verbindungsfehler')
        }
      })()
      return
    }
    setQ('')
    setFokus(false)
    feld.current?.blur()
    onNavigiert?.()
    router.push(t.ziel)
  }

  const offen = fokus && treffer.length > 0

  return (
    <div className={`befehlsfeld${gross ? ' gross' : ''}`}>
      {/* Composer im Claude-App-Stil: runde Kapsel, Mikro + Senden im Feld. */}
      <div className="composer">
        <input
          ref={feld}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setAktiv(0)
            setMeldung(null)
          }}
          onFocus={() => setFokus(true)}
          onBlur={() => setTimeout(() => setFokus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setAktiv((i) => Math.min(i + 1, treffer.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setAktiv((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && treffer[aktiv]) {
              e.preventDefault()
              oeffnen(treffer[aktiv])
            } else if (e.key === 'Escape') {
              setQ('')
              feld.current?.blur()
            }
          }}
          placeholder={'Was möchtest du tun? — z. B. „Bestellung anlegen", „P01670", „Umsatz je Monat"'}
          aria-label="Befehl oder Suche"
        />
        {/* Reinquatschen: Diktat läuft live ins Feld, die Treffer folgen sofort. */}
        <MikrofonKnopf
          onText={(text) => {
            setQ(text)
            setAktiv(0)
            setFokus(true)
            feld.current?.focus()
          }}
        />
        <button
          type="button"
          className="composer-knopf senden"
          disabled={!q.trim() || treffer.length === 0}
          title="Besten Treffer öffnen"
          aria-label="Besten Treffer öffnen"
          onMouseDown={(e) => {
            e.preventDefault()
            if (treffer[aktiv]) oeffnen(treffer[aktiv])
          }}
        >
          <SendenSymbol />
        </button>
      </div>
      {meldung && (
        <div className="notice danger" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="led warn" style={{ marginRight: 6 }} />
          {meldung}
        </div>
      )}
      {offen && (
        <div className="befehls-liste" role="listbox">
          {treffer.map((t, i) => (
            <button
              key={`${t.gruppe}-${t.ziel}-${t.label}`}
              type="button"
              role="option"
              aria-selected={i === aktiv}
              className={`befehls-treffer${i === aktiv ? ' aktiv' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                oeffnen(t)
              }}
              onMouseEnter={() => setAktiv(i)}
            >
              <span className="mono-label" style={{ width: 64, flex: 'none' }}>{t.gruppe}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{t.label}</span>
              <span className="muted small">{t.hinweis}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
