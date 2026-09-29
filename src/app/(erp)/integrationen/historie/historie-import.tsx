'use client'
import { useRef, useState } from 'react'
import type { ActionResult } from '@/modules/shared/action'
import {
  type HistorieBestellung,
  bestellungenAusExport,
  vorschau,
  wirdUebernommen,
} from '@/modules/integrationen/shopify-csv'
import { money, qty } from '@/modules/shared/format'
import { Stat } from '@/components/ui'

/** Bestellungen je Aufruf — hält jede Anfrage klein und unter dem Zeitlimit. */
const PAKET = 100

type Pruefung = { unbekannteSkus: string[]; vorhanden: number }
type Stand = { angelegt: number; vorhanden: number; offenJung: number; neueArtikel: number; fehler: string[] }

/**
 * Historie aus dem Shopify-Export: Datei wählen, Vorschau prüfen, in Paketen
 * übernehmen. Gelesen und zerlegt wird im Browser — an den Server gehen nur
 * die fertigen Bestellungen, paketweise und idempotent (abbrechen und neu
 * starten ist gefahrlos).
 */
export function HistorieImport({
  pruefen,
  importieren,
}: {
  pruefen: (skus: string[], namen: string[]) => Promise<ActionResult>
  importieren: (bestellungen: HistorieBestellung[]) => Promise<ActionResult>
}) {
  const [bestellungen, setBestellungen] = useState<HistorieBestellung[] | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [pruefung, setPruefung] = useState<Pruefung | null>(null)
  const [laeuft, setLaeuft] = useState(false)
  const [erledigt, setErledigt] = useState(0)
  const [stand, setStand] = useState<Stand | null>(null)
  const abbrechen = useRef(false)

  const uebersicht = bestellungen ? vorschau(bestellungen) : null
  const zuUebernehmen = bestellungen?.filter((b) => wirdUebernommen(b)) ?? []

  async function dateiGewaehlt(datei: File | undefined) {
    setFehler(null)
    setPruefung(null)
    setStand(null)
    setErledigt(0)
    setBestellungen(null)
    if (!datei) return
    const { bestellungen: gelesen, fehlendeSpalten } = bestellungenAusExport(await datei.text())
    if (fehlendeSpalten.length > 0) {
      setFehler(
        `Das ist kein Shopify-Bestellexport — es fehlen die Spalten ${fehlendeSpalten.join(', ')}. ` +
          'Export: Shopify-Admin → Bestellungen → Exportieren → „Alle Bestellungen", CSV.',
      )
      return
    }
    setBestellungen(gelesen)
    const v = vorschau(gelesen)
    const r = await pruefen(v.skus, gelesen.map((b) => b.name))
    if (r && 'error' in r) setFehler(r.error)
    else if (r && 'daten' in r && r.daten) setPruefung(r.daten as Pruefung)
  }

  async function starten() {
    abbrechen.current = false
    setLaeuft(true)
    setFehler(null)
    const summe: Stand = stand ?? { angelegt: 0, vorhanden: 0, offenJung: 0, neueArtikel: 0, fehler: [] }
    try {
      for (let i = erledigt; i < zuUebernehmen.length; i += PAKET) {
        if (abbrechen.current) break
        const r = await importieren(zuUebernehmen.slice(i, i + PAKET))
        if (r && 'error' in r) {
          setFehler(`Paket ab ${zuUebernehmen[i].name}: ${r.error}`)
          break
        }
        const d = (r && 'daten' in r ? r.daten : null) as Stand | null
        if (d) {
          summe.angelegt += d.angelegt
          summe.vorhanden += d.vorhanden
          summe.offenJung += d.offenJung
          summe.neueArtikel += d.neueArtikel
          summe.fehler = [...summe.fehler, ...d.fehler].slice(0, 50)
        }
        setStand({ ...summe })
        setErledigt(Math.min(i + PAKET, zuUebernehmen.length))
      }
    } finally {
      setLaeuft(false)
    }
  }

  const anteil = zuUebernehmen.length > 0 ? erledigt / zuUebernehmen.length : 0

  return (
    <div>
      <label className="field" style={{ maxWidth: 480 }}>
        <span>Shopify-Bestellexport (CSV)</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={laeuft}
          onChange={(e) => void dateiGewaehlt(e.target.files?.[0])}
        />
      </label>

      {fehler && <div className="notice danger">{fehler}</div>}

      {uebersicht && (
        <div className="grid-3" style={{ margin: '12px 0' }}>
          <Stat
            label="Bestellungen im Export"
            value={qty(uebersicht.gesamt)}
            hint={`${uebersicht.von?.slice(0, 10) ?? '—'} bis ${uebersicht.bis?.slice(0, 10) ?? '—'}`}
          />
          <Stat
            label="Werden übernommen"
            value={qty(uebersicht.uebernommen)}
            hint={`davon ${qty(uebersicht.storniert)} storniert/erstattet · ${qty(uebersicht.offenJung)} offen aus den letzten 60 Tagen bleiben dem Live-Import`}
          />
          <Stat
            label="Warenumsatz netto"
            value={money(uebersicht.umsatzNetto)}
            hint="ohne Versand, ohne Stornos"
          />
        </div>
      )}

      {pruefung && (
        <p className="small">
          <strong>{qty(pruefung.vorhanden)}</strong> Bestellungen sind schon in KRNL und werden
          übersprungen.{' '}
          {pruefung.unbekannteSkus.length > 0 ? (
            <>
              <strong>{qty(pruefung.unbekannteSkus.length)}</strong> SKUs kennt KRNL nicht — sie
              werden als archivierte Historie-Artikel angelegt (unsichtbar im Katalog):{' '}
              <span className="mono">
                {pruefung.unbekannteSkus.slice(0, 20).join(', ')}
                {pruefung.unbekannteSkus.length > 20 ? ' …' : ''}
              </span>
            </>
          ) : (
            'Alle SKUs sind bekannt.'
          )}
        </p>
      )}

      {bestellungen && zuUebernehmen.length > 0 && (
        <div className="actions" style={{ gap: 10, alignItems: 'center' }}>
          {laeuft ? (
            <button type="button" onClick={() => (abbrechen.current = true)}>
              Anhalten
            </button>
          ) : erledigt < zuUebernehmen.length ? (
            <button type="button" className="primary" onClick={() => void starten()}>
              {erledigt > 0 && erledigt < zuUebernehmen.length
                ? `Fortsetzen ab ${qty(erledigt)}`
                : `${qty(zuUebernehmen.length)} Bestellungen übernehmen`}
            </button>
          ) : null}
          <div className="historie-fortschritt" aria-label="Fortschritt">
            <div style={{ width: `${Math.round(anteil * 100)}%` }} />
          </div>
          <span className="mono small">
            {qty(erledigt)} / {qty(zuUebernehmen.length)}
          </span>
        </div>
      )}

      {stand && (
        <p className="small" style={{ marginTop: 10 }}>
          <span className={`led ${stand.fehler.length ? 'warn' : 'ok'}`} /> {qty(stand.angelegt)} übernommen,{' '}
          {qty(stand.vorhanden)} schon vorhanden, {qty(stand.neueArtikel)} Historie-Artikel angelegt
          {stand.fehler.length > 0 && (
            <>
              {' '}— {stand.fehler.length} Fehler:
              <span className="mono"> {stand.fehler.slice(0, 5).join(' | ')}</span>
            </>
          )}
          {erledigt >= zuUebernehmen.length && !laeuft ? ' — fertig.' : ''}
        </p>
      )}
    </div>
  )
}
