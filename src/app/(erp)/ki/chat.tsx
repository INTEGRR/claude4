'use client'
import { Fragment, useRef, useState } from 'react'

/**
 * Chat-Oberfläche des KI-Agenten. Antworten kommen als NDJSON-Stream von
 * /api/ki; Markdown-Tabellen werden gerendert und lassen sich als CSV
 * herunterladen. Bewusst ohne Markdown-Bibliothek — der kleine Renderer
 * unten deckt Tabellen, Listen, Überschriften und Inline-Auszeichnung ab.
 */

interface Msg {
  role: 'user' | 'assistant'
  text: string
  sqls: string[]
}

const BEISPIELE = [
  'Welche 5 Komponenten haben den höchsten Bestandswert?',
  'Wie viele Tastaturen je Farbe wurden diesen Monat gefertigt?',
  'Zeig mir alle offenen Aufträge mit Kunde und Rückstandsstatus.',
  'Welche Komponenten reichen bei aktueller Prognose nicht mehr aus?',
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
      blocks.push(<div key={key++} style={{ fontWeight: 700, margin: '10px 0 4px' }}>{inline(line.replace(/^#+ /, ''))}</div>)
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
    const history = [...msgs, { role: 'user' as const, text, sqls: [] }]
    setMsgs([...history, { role: 'assistant', text: '', sqls: [] }])

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
            | { type: 'error'; text: string }
            | { type: 'done' }
          if (ev.type === 'text') patchLast((m) => ({ ...m, text: m.text + ev.text }))
          if (ev.type === 'sql') patchLast((m) => ({ ...m, sqls: [...m.sqls, ev.query] }))
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
              Fragen zu allen ERP-Daten — der Agent liest die Datenbank (nur lesend) und
              bereitet die Antwort auf. Zum Beispiel:
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
                <summary className="small muted">
                  {m.sqls.length} SQL-Abfrage{m.sqls.length > 1 ? 'n' : ''}
                </summary>
                {m.sqls.map((q, j) => (
                  <pre key={j}>{q}</pre>
                ))}
              </details>
            )}
            {m.role === 'user' ? <p style={{ margin: 0 }}>{m.text}</p> : <Markdown text={m.text} />}
            {m.role === 'assistant' && m.text === '' && !status && <span className="muted">…</span>}
          </div>
        ))}
        {status && <div className="ki-status muted small">⚙ {status}</div>}
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
