'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { bulkStart, bulkZettel } from './actions'
import { isActionError } from '@/modules/shared/action'
import { Badge } from '@/components/ui'
import { date, qty } from '@/modules/shared/format'

/**
 * Die Auftragsliste mit Bulk-Bahnhof (BUG/00003): startbare Aufträge
 * (bestätigt + Material vollständig reserviert) sind anhakbar, „Alle
 * auswählen" nimmt die gefilterte Liste. Der Abschluss ist eine
 * 2-Stufen-Maske: erst gehen die Zettel an die Druckbrücke (oder als
 * Sammeldruck in den Tab), und erst wenn der Druck bestätigt ist, wird
 * „Produktion starten" frei — gestartet wird über die Registry-Aktion,
 * die nicht mehr Startbares überspringt und namentlich meldet.
 */

export interface BulkZeile {
  id: string
  number: string
  product: string
  qty_to_produce: number
  qty_produced: number
  state: string
  scheduled_date: string
  sales_order_number: string | null
  sales_order_id: string | null
  missing: number
}

type Stufe = 'auswahl' | 'gedruckt' | 'startet'

export function FertigungBulk({ rows }: { rows: BulkZeile[] }) {
  const router = useRouter()
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set())
  const [stufe, setStufe] = useState<Stufe>('auswahl')
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null)

  const startbar = (r: BulkZeile) => r.state === 'confirmed' && r.missing === 0
  const startbare = rows.filter(startbar)
  const auswahl = [...gewaehlt].filter((id) => rows.some((r) => r.id === id && startbar(r)))

  const umschalten = (id: string) => {
    // Jede Änderung der Auswahl entwertet eine schon bestätigte Druckstufe.
    setStufe('auswahl')
    setGewaehlt((s) => {
      const neu = new Set(s)
      if (neu.has(id)) neu.delete(id)
      else neu.add(id)
      return neu
    })
  }

  const alle = () => {
    setStufe('auswahl')
    setGewaehlt((s) =>
      s.size >= startbare.length ? new Set() : new Set(startbare.map((r) => r.id)),
    )
  }

  const formdaten = () => {
    const fd = new FormData()
    for (const id of auswahl) fd.append('ids', id)
    return fd
  }

  async function drucken() {
    setMeldung(null)
    const result = await bulkZettel(formdaten())
    if (isActionError(result)) {
      setMeldung({ text: result.error, fehler: true })
      return
    }
    if (result && 'info' in result) {
      // Ohne Druckbrücke kommt der Sammeldruck als Link zurück — Tab öffnen.
      if (result.link) window.open(result.link, '_blank', 'noopener')
      setMeldung({ text: result.info, fehler: false })
    }
    setStufe('gedruckt')
  }

  async function starten() {
    setStufe('startet')
    setMeldung(null)
    const result = await bulkStart(formdaten())
    if (isActionError(result)) {
      setStufe('gedruckt')
      setMeldung({ text: result.error, fehler: true })
      return
    }
    setMeldung({
      text: result && 'info' in result ? result.info : 'Produktion gestartet.',
      fehler: false,
    })
    setGewaehlt(new Set())
    setStufe('auswahl')
    router.refresh()
  }

  return (
    <>
      {/* Bulk-Bahnhof: erscheint, sobald etwas auswählbar ist. */}
      {startbare.length > 0 && (
        <div className="actions" style={{ padding: '0 12px 12px', flexWrap: 'wrap' }}>
          <button type="button" className="small" onClick={alle}>
            {auswahl.length >= startbare.length ? 'Auswahl leeren' : `Alle ${startbare.length} startbaren auswählen`}
          </button>
          <span className="mono-label">{auswahl.length} ausgewählt</span>
          <button
            type="button"
            className="small"
            disabled={auswahl.length === 0}
            onClick={() => void drucken()}
          >
            1. Zettel drucken
          </button>
          <button
            type="button"
            className="primary small"
            disabled={stufe !== 'gedruckt' || auswahl.length === 0}
            onClick={() => void starten()}
            title={
              stufe === 'gedruckt'
                ? undefined
                : 'Erst die Zettel drucken — dann wird der Start frei'
            }
          >
            {stufe === 'startet' ? 'Startet…' : '2. Druck ok — Produktion starten'}
          </button>
        </div>
      )}
      {meldung && (
        <div className={`notice ${meldung.fehler ? 'danger' : 'ok'}`} style={{ margin: '0 12px 12px' }}>
          {meldung.text}
        </div>
      )}

      <table>
        <thead>
          <tr>
            {startbare.length > 0 && <th style={{ width: 34 }} aria-label="Auswahl" />}
            <th>Nummer</th>
            <th>Produkt</th>
            <th className="num">Menge</th>
            <th>Status</th>
            <th>Material</th>
            <th>Auftrag</th>
            <th>Termin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {startbare.length > 0 && (
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${r.number} auswählen`}
                    checked={gewaehlt.has(r.id) && startbar(r)}
                    disabled={!startbar(r)}
                    onChange={() => umschalten(r.id)}
                  />
                </td>
              )}
              <td className="mono"><Link href={`/fertigung/${r.id}`}>{r.number}</Link></td>
              <td>{r.product}</td>
              <td className="num mono">
                {qty(r.qty_produced)} / {qty(r.qty_to_produce)}
              </td>
              <td><Badge state={r.state} kind="mo" /></td>
              <td>
                {r.state === 'done' || r.state === 'cancel' ? (
                  <span className="muted small">—</span>
                ) : r.missing > 0 ? (
                  <span className="badge warn">{r.missing} fehlt</span>
                ) : (
                  <span className="badge success">vollständig</span>
                )}
              </td>
              <td className="mono">
                {r.sales_order_id ? (
                  <Link href={`/verkauf/${r.sales_order_id}`}>{r.sales_order_number}</Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="mono nowrap">{date(r.scheduled_date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
