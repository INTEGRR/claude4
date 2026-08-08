'use client'
import { Fragment, useRef, useState } from 'react'
import { ColumnChart, HBars, ShareBar } from '@/components/charts'
import type { Diagramm } from '@/modules/ki/diagramm'
import { money, qty as menge } from '@/modules/shared/format'

/**
 * Chat-Oberfläche des KI-Agenten. Antworten kommen als NDJSON-Stream von
 * /api/ki; Markdown-Tabellen werden gerendert und lassen sich als CSV
 * herunterladen. Bewusst ohne Markdown-Bibliothek — der kleine Renderer
 * unten deckt Tabellen, Listen, Überschriften und Inline-Auszeichnung ab.
 */

interface Vorschlag {
  id: string
  aktion: string
  label: string
  bereich: string
  zusammenfassung: string
  begruendung?: string
  parameter: Record<string, unknown>
  /** null = offen, sonst das Ergebnis der Entscheidung */
  ergebnis?: { ok: boolean; text: string; link?: string } | 'verworfen'
}

interface Msg {
  role: 'user' | 'assistant'
  text: string
  sqls: string[]
  charts: Diagramm[]
  aktionen: Vorschlag[]
}

const BEISPIELE = [
  'Welche 5 Komponenten haben den höchsten Bestandswert?',
  'Zeig den Bestandswert der letzten 12 Monate als Diagramm.',
  'Wie viele Tastaturen je Farbe wurden diesen Monat gefertigt?',
  'Welche Komponenten reichen bei aktueller Prognose nicht mehr aus?',
  'Lege für die Schrauben M2x6 einen Meldebestand an: unter 500 auf 4000 auffüllen.',
]

// --- Mini-Markdown ---------------------------------------------------------

function inline(text: string): React.ReactNode {
  // **fett** und `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

function parseTable(lines: string[]): { header: string[]; rows: string[][] } {
  const cells = (line: string) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const header = cells(lines[0])
  const rows = lines.slice(2).map(cells)
  return { header, rows }
}

function tableToCsv(header: string[], rows: string[][]): string {
  const esc = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [header, ...rows].map((r) => r.map(esc).join(';')).join('\n')
}

function CsvButton({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <button
      type="button"
      className="small"
      style={{ marginBottom: 8 }}
      onClick={() => {
        const blob = new Blob(['﻿' + tableToCsv(header, rows)], {
          type: 'text/csv;charset=utf-8',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'auswertung.csv'
        a.click()
        URL.revokeObjectURL(url)
      }}
    >
      Als CSV herunterladen
    </button>
  )
}

function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('|') && lines[i + 1]?.trim().match(/^\|?[\s:|-]+\|?$/)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) tableLines.push(lines[i++].trim())
      const { header, rows } = parseTable(tableLines)
      blocks.push(
        <div key={key++} style={{ margin: '8px 0' }}>
          <CsvButton header={header} rows={rows} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{header.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, j) => (
                  <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>,
      )
      continue
    }

    if (/^#{1,4} /.test(line)) {
      blocks.push(<div key={key++} style={{ fontWeight: 650, margin: '10px 0 4px' }}>{inline(line.replace(/^#+ /, ''))}</div>)
      i++
      continue
    }

    if (/^[-*] /.test(line.trim())) {
      const items: string[] = []
      while (i < lines.length && /^[-*] /.test(lines[i].trim())) items.push(lines[i++].trim().slice(2))
      blocks.push(
        <ul key={key++} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
          {items.map((item, j) => <li key={j}>{inline(item)}</li>)}
        </ul>,
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('|') && !/^[-*#] /.test(lines[i].trim())) {
      para.push(lines[i++])
    }
    blocks.push(<p key={key++} style={{ margin: '4px 0' }}>{inline(para.join(' '))}</p>)
  }
  return <>{blocks}</>
}

// --- Diagramm --------------------------------------------------------------

/**
 * Der Agent bestimmt Inhalt und Art, das Aussehen kommt aus denselben
 * Komponenten wie die festen Auswertungen — eine Antwort soll nicht anders
 * aussehen als der Rest des Hauses.
 */
function ChartCard({ d }: { d: Diagramm }) {
  const format = d.einheit === '€' ? money : (v: number) => menge(v)
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <header>
        <span>{d.titel}</span>
        {d.einheit && <span className="actions"><span className="mono-label">{d.einheit}</span></span>}
      </header>
      <div className="body" style={{ paddingTop: 12 }}>
        {d.art === 'saeulen' && (
          <ColumnChart
            categories={d.kategorien ?? []}
            series={(d.serien ?? []).map((r) => ({ name: r.name, values: r.werte }))}
            unit={d.einheit}
          />
        )}
        {d.art === 'balken' && (
          <HBars
            unit={d.einheit}
            rows={(d.punkte ?? []).map((p) => ({ label: p.label, value: p.wert }))}
          />
        )}
        {d.art === 'anteile' && (
          <ShareBar
            parts={(d.punkte ?? []).filter((p) => p.wert > 0).map((p) => ({ label: p.label, value: p.wert }))}
            format={format}
          />
        )}
      </div>
    </div>
  )
}

// --- Aktionsvorschlag ------------------------------------------------------

/**
 * Vorschlag zum Anlegen. Der Agent hat hier nichts ausgeführt — erst der
 * Klick auf "Ausführen" schickt die Aktion an den Server, der Rechte und
 * Felder erneut prüft. Alle Felder stehen offen da, damit man sieht, was man
 * bestätigt.
 */
function AktionCard({
  v,
  onEntscheidung,
}: {
  v: Vorschlag
  onEntscheidung: (id: string, ergebnis: NonNullable<Vorschlag['ergebnis']>) => void
}) {
  const [busy, setBusy] = useState(false)

  async function ausfuehren() {
    setBusy(true)
    try {
      const res = await fetch('/api/ki/aktion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aktion: v.aktion, parameter: v.parameter }),
      })
      const data = (await res.json()) as { text?: string; link?: string; error?: string }
      onEntscheidung(
        v.id,
        res.ok
          ? { ok: true, text: data.text ?? 'Ausgeführt.', link: data.link }
          : { ok: false, text: data.error ?? `Fehlgeschlagen (${res.status})` },
      )
    } catch (err) {
      onEntscheidung(v.id, {
        ok: false,
        text: err instanceof Error ? err.message : 'Verbindungsfehler',
      })
    } finally {
      setBusy(false)
    }
  }

  const erledigt = v.ergebnis !== undefined

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <header>
        <span>
          <span className={`led ${erledigt ? (v.ergebnis === 'verworfen' ? 'off' : 'ok') : 'on'}`} />{' '}
          {v.label}
        </span>
        <span className="actions"><span className="mono-label">{v.bereich}</span></span>
      </header>
      <div className="body">
        <p style={{ margin: '0 0 8px' }}>{v.zusammenfassung}</p>
        {v.begruendung && <p className="muted small" style={{ margin: '0 0 8px' }}>{v.begruendung}</p>}

        <details style={{ marginBottom: 10 }}>
          <summary className="mono-label" style={{ cursor: 'pointer' }}>Felder im Detail</summary>
          <div className="display-panel" style={{ margin: '6px 0 0' }}>
            <div className="display-head">
              <span>{v.aktion}</span>
              <span>wird geprüft</span>
            </div>
            <pre style={{ background: 'transparent', border: 0, padding: 0, margin: 0 }}>
              {JSON.stringify(v.parameter, null, 2)}
            </pre>
          </div>
        </details>

        {v.ergebnis === undefined ? (
          <div className="actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void ausfuehren()}>
              {busy && <span className="led" style={{ background: 'currentColor' }} />}
              Ausführen
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onEntscheidung(v.id, 'verworfen')}
            >
              Verwerfen
            </button>
            <span className="muted small">Nichts ist bisher gespeichert.</span>
          </div>
        ) : v.ergebnis === 'verworfen' ? (
          <div className="muted small">
            <span className="led off" /> Verworfen — es wurde nichts angelegt.
          </div>
        ) : v.ergebnis.ok ? (
          <div className="notice success" style={{ marginBottom: 0 }}>
            <span className="led ok" /> {v.ergebnis.text}{' '}
            {v.ergebnis.link && <a href={v.ergebnis.link}>Öffnen</a>}
          </div>
        ) : (
          <div className="notice danger" style={{ marginBottom: 0 }}>
            <span className="led warn" /> {v.ergebnis.text}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Chat ------------------------------------------------------------------

export function KiChat() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  async function send(frage: string) {
    const text = frage.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    const leer = { sqls: [], charts: [], aktionen: [] }
    const history = [...msgs, { role: 'user' as const, text, ...leer }]
    setMsgs([...history, { role: 'assistant', text: '', ...leer }])

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMsgs((cur) => [...cur.slice(0, -1), fn(cur.at(-1)!)])

    try {
      const res = await fetch('/api/ki', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, text: m.text })),
        }),
      })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null)
        patchLast((m) => ({ ...m, text: data?.error ?? `Fehler (${res.status})` }))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const zeilen = buffer.split('\n')
        buffer = zeilen.pop() ?? ''
        for (const zeile of zeilen) {
          if (!zeile.trim()) continue
          const ev = JSON.parse(zeile) as
            | { type: 'text'; text: string }
            | { type: 'status'; text: string }
            | { type: 'sql'; query: string }
            | { type: 'chart'; chart: Diagramm }
            | ({ type: 'aktion' } & Vorschlag)
            | { type: 'error'; text: string }
            | { type: 'done' }
          if (ev.type === 'text') patchLast((m) => ({ ...m, text: m.text + ev.text }))
          if (ev.type === 'sql') patchLast((m) => ({ ...m, sqls: [...m.sqls, ev.query] }))
          if (ev.type === 'chart') patchLast((m) => ({ ...m, charts: [...m.charts, ev.chart] }))
          if (ev.type === 'aktion') {
            const { type: _t, ...vorschlag } = ev
            patchLast((m) => ({ ...m, aktionen: [...m.aktionen, vorschlag] }))
          }
          if (ev.type === 'status') setStatus(ev.text)
          if (ev.type === 'error') patchLast((m) => ({ ...m, text: m.text + '\n\n' + ev.text }))
          if (ev.type === 'done') setStatus(null)
        }
        bottomRef.current?.scrollIntoView({ block: 'end' })
      }
    } catch (err) {
      patchLast((m) => ({
        ...m,
        text: m.text + '\n\nVerbindungsfehler: ' + (err instanceof Error ? err.message : String(err)),
      }))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="ki-chat">
      <div className="ki-messages">
        {msgs.length === 0 && (
          <div className="ki-empty">
            <p className="muted">
              Fragen zu allen ERP-Daten — der Agent liest die Datenbank, bereitet die Antwort
              auf und zeichnet bei Bedarf ein Diagramm. Anlegen kann er auch, aber nur als
              Vorschlag: gespeichert wird erst nach Ihrer Bestätigung. Zum Beispiel:
            </p>
            <div className="ki-beispiele">
              {BEISPIELE.map((b) => (
                <button key={b} type="button" className="small" onClick={() => void send(b)}>
                  {b}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`ki-msg ${m.role}`}>
            {m.sqls.length > 0 && (
              <details className="ki-sql">
                <summary className="mono-label" style={{ cursor: 'pointer' }}>
                  {m.sqls.length} SQL-Abfrage{m.sqls.length > 1 ? 'n' : ''}
                </summary>
                {/* Roh-SQL ist eine Datenfläche, kein Fließtext: Display mit Typenschild-Kopf. */}
                {m.sqls.map((q, j) => (
                  <div key={j} className="display-panel" style={{ margin: '4px 0 8px' }}>
                    <div className="display-head">
                      <span>
                        SQL · Abfrage {j + 1}/{m.sqls.length}
                      </span>
                      <span>nur lesend</span>
                    </div>
                    <pre style={{ background: 'transparent', border: 0, padding: 0, margin: 0 }}>
                      {q}
                    </pre>
                  </div>
                ))}
              </details>
            )}
            {m.role === 'user' ? <p style={{ margin: 0 }}>{m.text}</p> : <Markdown text={m.text} />}
            {m.charts.map((d, j) => (
              <ChartCard key={j} d={d} />
            ))}
            {m.aktionen.map((v) => (
              <AktionCard
                key={v.id}
                v={v}
                onEntscheidung={(id, ergebnis) =>
                  setMsgs((cur) =>
                    cur.map((msg) => ({
                      ...msg,
                      aktionen: msg.aktionen.map((a) => (a.id === id ? { ...a, ergebnis } : a)),
                    })),
                  )
                }
              />
            ))}
            {m.role === 'assistant' && m.text === '' && m.charts.length === 0 &&
              m.aktionen.length === 0 && !status && (
              <span className="mono-label">
                <span className="led on" /> wartet
              </span>
            )}
          </div>
        ))}
        {status && (
          <div className="ki-status muted small">
            <span className="led on" /> {status}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="ki-input row"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Frage an die Daten stellen …"
          disabled={busy}
        />
        <div className="shrink">
          <button className="primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? 'Denkt …' : 'Fragen'}
          </button>
        </div>
      </form>
    </div>
  )
}
