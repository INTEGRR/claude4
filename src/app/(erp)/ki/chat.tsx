'use client'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ColumnChart, HBars, ShareBar } from '@/components/charts'
import type { Diagramm } from '@/modules/ki/diagramm'
import { money, qty as menge } from '@/modules/shared/format'
import { gruppenSpalten, gruppiereVorschlaege } from '@/modules/ki/vorschlag-gruppen'
import { MikrofonKnopf, SendenSymbol } from '@/components/spracheingabe'
import { HexcoreMark } from '@/components/marke'
import { SprechenLog, useGespraech, ZUSTAND_TEXT } from '@/app/(erp)/sprechen/nutze-gespraech'
import { VorschlagEditor, Zelle } from './vorschlag-editor'

/**
 * Chat-Oberfläche des KI-Agenten. Antworten kommen als NDJSON-Stream von
 * /api/ki; Markdown-Tabellen werden gerendert und lassen sich als CSV
 * herunterladen. Bewusst ohne Markdown-Bibliothek — der kleine Renderer
 * unten deckt Tabellen, Listen, Überschriften und Inline-Auszeichnung ab.
 *
 * Dazu der Buddy-Modus (Hexcore-Knopf im Composer): dieselbe Sprachsitzung
 * wie auf /sprechen, aber als Vollfläche IM Chat — wie der Voice-Mode der
 * Claude-/ChatGPT-Apps. Das Sprechen ist der Kern-Einstieg ins ERP; der
 * Chat kann deshalb beides, tippen und reden.
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
  'Leg ein Produkt „Anvil Native 1800" an, in 3 Gehäusefarben und 4 Switch-Typen.',
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

/** Diagrammdaten als CSV — dieselben Zahlen, die auch gezeichnet werden. */
function diagrammCsv(d: Diagramm): string {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  if (d.art === 'saeulen') {
    const header = ['Kategorie', ...(d.serien ?? []).map((s) => s.name)]
    const rows = (d.kategorien ?? []).map((k, i) => [
      k,
      ...(d.serien ?? []).map((s) => s.werte[i] ?? 0),
    ])
    return [header, ...rows].map((r) => r.map(esc).join(';')).join('\n')
  }
  const header = ['Bezeichnung', d.einheit ? `Wert (${d.einheit})` : 'Wert']
  return [header, ...(d.punkte ?? []).map((p) => [p.label, p.wert])]
    .map((r) => r.map(esc).join(';'))
    .join('\n')
}

function herunterladen(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * SVG → PNG im Browser. Die SVGs färben über CSS-Variablen (--viz-…), die in
 * einer freistehenden Bilddatei fehlen würden — deshalb werden die
 * berechneten Farben vor der Serialisierung als Attribute eingebrannt.
 */
async function svgAlsPng(svg: SVGSVGElement, name: string) {
  const klon = svg.cloneNode(true) as SVGSVGElement
  const originale = [svg, ...svg.querySelectorAll<SVGElement>('*')]
  const kopien = [klon, ...klon.querySelectorAll<SVGElement>('*')]
  originale.forEach((el, i) => {
    const stil = getComputedStyle(el)
    kopien[i].setAttribute('fill', stil.fill)
    kopien[i].setAttribute('stroke', stil.stroke)
    kopien[i].setAttribute('font-family', stil.fontFamily)
  })
  const breite = svg.viewBox.baseVal.width || svg.clientWidth
  const hoehe = svg.viewBox.baseVal.height || svg.clientHeight
  klon.setAttribute('width', String(breite))
  klon.setAttribute('height', String(hoehe))

  const img = new Image()
  await new Promise((res, rej) => {
    img.onload = res
    img.onerror = rej
    img.src =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(klon))
  })
  const canvas = document.createElement('canvas')
  const skala = 2
  canvas.width = breite * skala
  canvas.height = hoehe * skala
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  canvas.toBlob((b) => b && herunterladen(name, b), 'image/png')
}

/** Das eigentliche Zeichnen — geteilt zwischen Karte und Großansicht. */
function DiagrammInhalt({ d, hoehe }: { d: Diagramm; hoehe?: number }) {
  const format = d.einheit === '€' ? money : (v: number) => menge(v)
  return (
    <>
      {d.art === 'saeulen' && (
        <ColumnChart
          categories={d.kategorien ?? []}
          series={(d.serien ?? []).map((r) => ({ name: r.name, values: r.werte }))}
          unit={d.einheit}
          height={hoehe}
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
    </>
  )
}

/**
 * Der Agent bestimmt Inhalt und Art, das Aussehen kommt aus denselben
 * Komponenten wie die festen Auswertungen. Dazu (BUG/00008): Werte beim
 * Überfahren (native Tooltips der Charts), Großansicht mit Datentabelle im
 * Dialog, Export als PNG (Säulen-SVG) und CSV.
 */
function ChartCard({ d }: { d: Diagramm }) {
  const kartenRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const dateiname = d.titel.toLowerCase().replace(/[^a-zä-ü0-9]+/gi, '-').replace(/^-|-$/g, '') || 'diagramm'

  const alsPng = useCallback(() => {
    const svg = kartenRef.current?.querySelector('svg')
    if (svg) void svgAlsPng(svg, `${dateiname}.png`)
  }, [dateiname])

  const alsCsv = useCallback(() => {
    herunterladen(
      `${dateiname}.csv`,
      new Blob(['﻿' + diagrammCsv(d)], { type: 'text/csv;charset=utf-8' }),
    )
  }, [d, dateiname])

  // Tabelle der Großansicht: dieselben Zahlen wie im Bild, vollständig.
  const zeilen: (string | number)[][] =
    d.art === 'saeulen'
      ? (d.kategorien ?? []).map((k, i) => [k, ...(d.serien ?? []).map((s) => s.werte[i] ?? 0)])
      : (d.punkte ?? []).map((p) => [p.label, p.wert])
  const kopf =
    d.art === 'saeulen'
      ? ['Kategorie', ...(d.serien ?? []).map((s) => s.name)]
      : ['Bezeichnung', d.einheit ? `Wert (${d.einheit})` : 'Wert']

  return (
    <div className="card" style={{ marginBottom: 8 }} ref={kartenRef}>
      <header>
        <span>{d.titel}</span>
        <span className="actions">
          {d.einheit && <span className="mono-label">{d.einheit}</span>}
          {d.art === 'saeulen' && (
            <button type="button" className="small" onClick={alsPng}>PNG</button>
          )}
          <button type="button" className="small" onClick={alsCsv}>CSV</button>
          <button type="button" className="small" onClick={() => dialogRef.current?.showModal()}>
            Vergrößern
          </button>
        </span>
      </header>
      <div className="body" style={{ paddingTop: 12 }}>
        <DiagrammInhalt d={d} />
      </div>

      <dialog ref={dialogRef} className="chart-dialog">
        <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ flex: 1 }}>{d.titel}</strong>
          <div className="shrink actions">
            {d.art === 'saeulen' && (
              <button
                type="button"
                className="small"
                onClick={() => {
                  const svg = dialogRef.current?.querySelector('svg')
                  if (svg) void svgAlsPng(svg, `${dateiname}.png`)
                }}
              >
                PNG
              </button>
            )}
            <button type="button" className="small" onClick={alsCsv}>CSV</button>
            <button type="button" className="small" onClick={() => dialogRef.current?.close()}>
              Schließen
            </button>
          </div>
        </div>
        <DiagrammInhalt d={d} hoehe={380} />
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>{kopf.map((h, i) => <th key={h} className={i > 0 ? 'num' : undefined}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {zeilen.map((z, i) => (
                <tr key={i}>
                  {z.map((wert, j) => (
                    <td key={j} className={j > 0 ? 'num mono' : undefined}>
                      {typeof wert === 'number' ? menge(wert) : wert}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </dialog>
    </div>
  )
}

// --- Aktionsvorschlag ------------------------------------------------------

/** Ein Klick auf „Anlegen" — Server prüft Rechte und Felder erneut. */
async function vorschlagAusfuehren(
  v: Vorschlag,
): Promise<NonNullable<Exclude<Vorschlag['ergebnis'], 'verworfen'>>> {
  try {
    const res = await fetch('/api/ki/aktion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aktion: v.aktion, parameter: v.parameter }),
    })
    const data = (await res.json()) as { text?: string; link?: string; error?: string }
    return res.ok
      ? { ok: true, text: data.text ?? 'Ausgeführt.', link: data.link }
      : { ok: false, text: data.error ?? `Fehlgeschlagen (${res.status})` }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : 'Verbindungsfehler' }
  }
}

/**
 * Vorschlag zum Anlegen. Der Agent hat hier nichts ausgeführt — erst der
 * Klick auf "Anlegen" schickt die Aktion an den Server, der Rechte und Felder
 * erneut prüft.
 *
 * Die Felder stehen direkt als editierbares Formular in der Karte (Listen als
 * Tabellen mit editierbaren Zellen) — kein rohes JSON. Alternativ korrigiert
 * die KI per Zuruf („die Kürzel für Grün auf GN"), ohne dass die Frage von
 * vorn beginnt.
 */
function AktionCard({
  v,
  onEntscheidung,
  onParameter,
}: {
  v: Vorschlag
  onEntscheidung: (id: string, ergebnis: NonNullable<Vorschlag['ergebnis']>) => void
  onParameter: (id: string, parameter: Record<string, unknown>, zusammenfassung?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [anweisung, setAnweisung] = useState('')
  const [kiBusy, setKiBusy] = useState(false)
  const [kiHinweis, setKiHinweis] = useState<{ ok: boolean; text: string } | null>(null)

  async function ausfuehren() {
    setBusy(true)
    try {
      onEntscheidung(v.id, await vorschlagAusfuehren(v))
    } finally {
      setBusy(false)
    }
  }

  async function perKiAendern() {
    const text = anweisung.trim()
    if (!text || kiBusy) return
    setKiBusy(true)
    setKiHinweis(null)
    try {
      const res = await fetch('/api/ki/aktion/aendern', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aktion: v.aktion, parameter: v.parameter, anweisung: text }),
      })
      const data = (await res.json()) as {
        parameter?: Record<string, unknown>
        zusammenfassung?: string
        hinweis?: string | null
        error?: string
      }
      if (!res.ok || !data.parameter) {
        setKiHinweis({ ok: false, text: data.error ?? `Fehlgeschlagen (${res.status})` })
        return
      }
      onParameter(v.id, data.parameter, data.zusammenfassung)
      setAnweisung('')
      setKiHinweis({ ok: true, text: data.hinweis ?? 'Vorschlag überarbeitet.' })
    } catch (err) {
      setKiHinweis({
        ok: false,
        text: err instanceof Error ? err.message : 'Verbindungsfehler',
      })
    } finally {
      setKiBusy(false)
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

        {/* Die Felder stehen offen und editierbar da — wer den Vorschlag
            prüft, soll ihn im selben Zug korrigieren können. */}
        {!erledigt && (
          <VorschlagEditor
            parameter={v.parameter}
            onChange={(neu) => onParameter(v.id, neu)}
          />
        )}

        {!erledigt && (
          <div className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              value={anweisung}
              onChange={(e) => setAnweisung(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void perKiAendern()
                }
              }}
              placeholder={'Änderung per KI, z. B. „Kürzel für Grün auf GN"'}
              disabled={kiBusy || busy}
            />
            <div className="shrink">
              <button
                type="button"
                className="small"
                disabled={kiBusy || busy || !anweisung.trim()}
                onClick={() => void perKiAendern()}
              >
                {kiBusy && <span className="led" style={{ background: 'currentColor' }} />}
                Ändern
              </button>
            </div>
          </div>
        )}
        {kiHinweis && (
          <div className={`notice ${kiHinweis.ok ? 'info' : 'danger'}`} style={{ marginBottom: 8 }}>
            {kiHinweis.text}
          </div>
        )}

        {v.ergebnis === undefined ? (
          <div className="actions">
            {/* Violett: dieser Klick schreibt in die Daten — eine Entscheidung. */}
            <button className="wichtig" type="button" disabled={busy} onClick={() => void ausfuehren()}>
              {busy && <span className="led" style={{ background: 'currentColor' }} />}
              Anlegen
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

/**
 * Sammelkarte: viele gleichartige Vorschläge aus EINER Antwort (etwa ein
 * Meldebestand je Produkt) als eine Tabelle — je Vorschlag eine Zeile, Zellen
 * editierbar, einzelne Zeilen verwerfbar, ein Knopf legt alle offenen an.
 * Ausgeführt wird trotzdem je Zeile einzeln über /api/ki/aktion, damit jede
 * Zeile ihr eigenes Ergebnis (Erfolg, Fehler, Link) bekommt.
 */
function SammelCard({
  vorschlaege,
  onEntscheidung,
  onParameter,
}: {
  vorschlaege: Vorschlag[]
  onEntscheidung: (id: string, ergebnis: NonNullable<Vorschlag['ergebnis']>) => void
  onParameter: (id: string, parameter: Record<string, unknown>) => void
}) {
  const [busy, setBusy] = useState(false)
  const spalten = gruppenSpalten(vorschlaege)
  const offen = vorschlaege.filter((v) => v.ergebnis === undefined)
  const angelegt = vorschlaege.filter((v) => v.ergebnis !== undefined && v.ergebnis !== 'verworfen' && v.ergebnis.ok)
  const fehler = vorschlaege.filter((v) => v.ergebnis !== undefined && v.ergebnis !== 'verworfen' && !v.ergebnis.ok)
  const begruendung = vorschlaege.find((v) => v.begruendung)?.begruendung

  async function alleAusfuehren() {
    setBusy(true)
    try {
      // Nacheinander, nicht parallel: jede Zeile bucht für sich, und ein
      // Fehler in Zeile 3 hält Zeile 4 nicht auf.
      for (const v of offen) {
        onEntscheidung(v.id, await vorschlagAusfuehren(v))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <header>
        <span>
          <span className={`led ${offen.length > 0 ? 'on' : fehler.length > 0 ? 'warn' : 'ok'}`} />{' '}
          {vorschlaege[0].label} — {vorschlaege.length} Vorschläge
        </span>
        <span className="actions"><span className="mono-label">{vorschlaege[0].bereich}</span></span>
      </header>
      <div className="body">
        {begruendung && <p className="muted small" style={{ margin: '0 0 8px' }}>{begruendung}</p>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {spalten.map((s) => <th key={s}>{s}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {vorschlaege.map((v) => {
                const zeileOffen = v.ergebnis === undefined
                return (
                  <tr key={v.id}>
                    {spalten.map((s) => {
                      const wert = v.parameter[s]
                      // Beleg-IDs hat der Agent nachgeschlagen — von Hand
                      // editiert wären sie nur falsch. Anzeigen, nicht ändern.
                      if (s === 'record_id') {
                        return (
                          <td key={s} className="mono small" title={String(wert ?? '')}>
                            {typeof wert === 'string' ? wert.slice(0, 8) + '…' : '—'}
                          </td>
                        )
                      }
                      return (
                        <td key={s}>
                          {zeileOffen ? (
                            <Zelle
                              wert={wert}
                              onChange={(neu) => onParameter(v.id, { ...v.parameter, [s]: neu })}
                            />
                          ) : (
                            <span>{wert === undefined || wert === null ? '—' : String(wert)}</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="nowrap">
                      {zeileOffen ? (
                        <button
                          type="button"
                          className="small danger"
                          title="Diese Zeile verwerfen"
                          disabled={busy}
                          onClick={() => onEntscheidung(v.id, 'verworfen')}
                        >
                          ×
                        </button>
                      ) : v.ergebnis === 'verworfen' ? (
                        <span className="muted small"><span className="led off" /> verworfen</span>
                      ) : v.ergebnis!.ok ? (
                        <span className="small">
                          <span className="led ok" />{' '}
                          {v.ergebnis!.link ? <a href={v.ergebnis!.link}>angelegt</a> : 'angelegt'}
                        </span>
                      ) : (
                        <span className="small" title={v.ergebnis!.text}>
                          <span className="led warn" /> {v.ergebnis!.text}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {offen.length > 0 ? (
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="wichtig" type="button" disabled={busy} onClick={() => void alleAusfuehren()}>
              {busy && <span className="led" style={{ background: 'currentColor' }} />}
              Alle anlegen ({offen.length})
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => offen.forEach((v) => onEntscheidung(v.id, 'verworfen'))}
            >
              Alle verwerfen
            </button>
            <span className="muted small">Zellen sind editierbar. Nichts ist bisher gespeichert.</span>
          </div>
        ) : (
          <div className="muted small" style={{ marginTop: 8 }}>
            {angelegt.length} angelegt
            {fehler.length > 0 && `, ${fehler.length} fehlgeschlagen`}
            {vorschlaege.length - angelegt.length - fehler.length > 0 &&
              `, ${vorschlaege.length - angelegt.length - fehler.length} verworfen`}
            .
          </div>
        )}
      </div>
    </div>
  )
}

// --- Chat ------------------------------------------------------------------

export function KiChat({
  startFrage,
  sprechen,
}: { startFrage?: string; sprechen?: boolean } = {}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  /** Stream abgerissen (BUG/00010) — mit Merker, ob es im Hintergrund geschah. */
  const [abbruch, setAbbruch] = useState<{ imHintergrund: boolean } | null>(null)
  /** Buddy-Modus: die Sprachsitzung als Vollfläche statt des Textverlaufs. */
  const [buddy, setBuddy] = useState(false)
  const [gesammelt, setGesammelt] = useState(0)
  const stimme = useGespraech({ beiEnde: (notiert) => setGesammelt(notiert) })
  const bottomRef = useRef<HTMLDivElement>(null)
  const verlauf = useRef<HTMLDivElement>(null)
  const startGesendet = useRef(false)
  const letzteFrage = useRef('')

  /**
   * Liest man gerade weiter oben, darf die laufende Antwort die Position
   * nicht klauen (BUG/00009) — gescrollt wird nur, wenn man ohnehin (fast)
   * am Ende steht. Im Slide-out scrollt .ki-messages, auf /ki die Seite.
   */
  function amEnde(): boolean {
    const el = verlauf.current
    if (el && el.scrollHeight > el.clientHeight + 8) {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 140
    }
    const doc = document.documentElement
    return window.innerHeight + window.scrollY >= doc.scrollHeight - 140
  }

  // Solange die Antwort läuft, den Bildschirm wachhalten: das Display, das
  // sich abschaltet, ist der häufigste Grund für den Abriss (BUG/00010).
  useEffect(() => {
    if (!busy) return
    type Sperre = { release(): Promise<void> }
    const traeger = navigator as Navigator & {
      wakeLock?: { request(art: 'screen'): Promise<Sperre> }
    }
    let sperre: Sperre | null = null
    const anfordern = () => {
      traeger.wakeLock
        ?.request('screen')
        .then((s) => {
          sperre = s
        })
        .catch(() => undefined)
    }
    anfordern()
    // Nach Rückkehr in den Vordergrund ist die Sperre weg — neu anfordern.
    const beiSicht = () => {
      if (document.visibilityState === 'visible') anfordern()
    }
    document.addEventListener('visibilitychange', beiSicht)
    return () => {
      document.removeEventListener('visibilitychange', beiSicht)
      void sperre?.release().catch(() => undefined)
    }
  }, [busy])

  async function send(frage: string, basis?: Msg[]) {
    const text = frage.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setAbbruch(null)
    letzteFrage.current = text
    const leer = { sqls: [], charts: [], aktionen: [] }
    const history = [...(basis ?? msgs), { role: 'user' as const, text, ...leer }]
    setMsgs([...history, { role: 'assistant', text: '', ...leer }])
    // Zur eigenen Frage springen — ab da entscheidet amEnde().
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))

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
        const warAmEnde = amEnde()
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
        if (warAmEnde) bottomRef.current?.scrollIntoView({ block: 'end' })
      }
    } catch {
      // Stream abgerissen (Netz weg, PWA im Hintergrund eingefroren): die
      // Teilantwort bleibt stehen, unten erscheint „Erneut fragen" — und
      // geschah es im Hintergrund, fragt die Rückkehr automatisch nach.
      patchLast((m) => (m.text === '' ? { ...m, text: '_(abgebrochen)_' } : m))
      setAbbruch({ imHintergrund: document.visibilityState === 'hidden' })
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  /** Die abgerissene Frage neu stellen: Teilantwort + Frage raus, noch einmal. */
  function wiederholen() {
    const frage = letzteFrage.current
    if (!frage || busy) return
    setAbbruch(null)
    const basis = [...msgs]
    if (basis.at(-1)?.role === 'assistant') basis.pop()
    if (basis.at(-1)?.role === 'user') basis.pop()
    void send(frage, basis)
  }

  // Kam der Abriss, während die App im Hintergrund war, holt die Rückkehr
  // die Antwort von selbst — niemand soll einen toten Chat vorfinden.
  useEffect(() => {
    if (!abbruch?.imHintergrund) return
    const nachholen = () => {
      if (document.visibilityState === 'visible') wiederholen()
    }
    document.addEventListener('visibilitychange', nachholen)
    nachholen()
    return () => document.removeEventListener('visibilitychange', nachholen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abbruch])

  // Vom Befehlsfeld übergebene Frage (?frage=…) einmal automatisch stellen.
  useEffect(() => {
    if (startFrage && !startGesendet.current) {
      startGesendet.current = true
      void send(startFrage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startFrage])

  /** Buddy starten: Verbindungsaufbau direkt in der Klick-Geste (iOS-Audio). */
  function buddyStarten() {
    setGesammelt(0)
    setBuddy(true)
    void stimme.verbinden()
  }

  /** Zurück zum Text-Chat; eine laufende Sitzung wird sauber beendet. */
  function buddySchliessen() {
    if (stimme.aktiv) stimme.trennen(true)
    setBuddy(false)
  }

  // Buddy-Modus: dieselbe Sitzung wie /sprechen, als Vollfläche im Chat —
  // das Hexcore ist der Gesprächspartner, darunter das kompakte Live-Log.
  if (buddy) {
    return (
      <div className="ki-chat">
        <div className="ki-buddy">
          <div className={`sprechen-kern zustand-${stimme.zustand}`} aria-live="polite">
            <HexcoreMark groesse={84} variante="voll" />
          </div>
          <div className="mono-label">{ZUSTAND_TEXT[stimme.zustand]}</div>

          {stimme.fehler && (
            <div className="notice danger" role="alert" style={{ marginBottom: 0 }}>
              <span className="led warn" style={{ marginRight: 6 }} />
              {stimme.fehler}
            </div>
          )}
          {/* Sitzung vorbei, Vorgänge notiert: der Weg zur Prüftabelle —
              gebucht wird NUR dort, nach Sichtprüfung. */}
          {stimme.zustand === 'aus' && gesammelt > 0 && (
            <div className="notice info" style={{ marginBottom: 0 }}>
              <span className="led wichtig" style={{ marginRight: 6 }} />
              {gesammelt === 1 ? 'Ein Vorgang' : `${gesammelt} Vorgänge`} notiert —{' '}
              <a href="/sprechen">prüfen &amp; buchen</a>
            </div>
          )}

          <div className="actions" style={{ justifyContent: 'center', marginTop: 4 }}>
            {stimme.aktiv ? (
              <button className="wichtig" type="button" onClick={() => stimme.trennen(true)}>
                Beenden
              </button>
            ) : (
              <button
                className="primary"
                type="button"
                onClick={() => void stimme.verbinden()}
                disabled={stimme.zustand === 'verbindet'}
              >
                {stimme.zustand === 'verbindet' ? 'Verbinde …' : 'Verbinden'}
              </button>
            )}
            <button type="button" onClick={buddySchliessen}>
              Zurück zum Chat
            </button>
          </div>

          <SprechenLog log={stimme.log} />
        </div>
      </div>
    )
  }

  return (
    <div className="ki-chat">
      <div className="ki-messages" ref={verlauf}>
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
            {gruppiereVorschlaege(m.aktionen).map((gruppe) => {
              const onEntscheidung = (
                id: string,
                ergebnis: NonNullable<Vorschlag['ergebnis']>,
              ) =>
                setMsgs((cur) =>
                  cur.map((msg) => ({
                    ...msg,
                    aktionen: msg.aktionen.map((a) => (a.id === id ? { ...a, ergebnis } : a)),
                  })),
                )
              const onParameter = (
                id: string,
                parameter: Record<string, unknown>,
                zusammenfassung?: string,
              ) =>
                setMsgs((cur) =>
                  cur.map((msg) => ({
                    ...msg,
                    aktionen: msg.aktionen.map((a) =>
                      a.id === id
                        ? {
                            ...a,
                            parameter,
                            zusammenfassung: zusammenfassung ?? a.zusammenfassung,
                            // Von Hand geändert heißt: nicht mehr der
                            // Vorschlag der KI, also auch nicht mehr deren
                            // Begründung.
                            begruendung: zusammenfassung ? a.begruendung : undefined,
                          }
                        : a,
                    ),
                  })),
                )
              // Viele gleichartige Vorschläge einer Antwort: EINE Tabelle
              // statt einer Kartenwand (siehe vorschlag-gruppen.ts).
              return gruppe.length > 1 ? (
                <SammelCard
                  key={gruppe[0].id}
                  vorschlaege={gruppe}
                  onEntscheidung={onEntscheidung}
                  onParameter={onParameter}
                />
              ) : (
                <AktionCard
                  key={gruppe[0].id}
                  v={gruppe[0]}
                  onEntscheidung={onEntscheidung}
                  onParameter={onParameter}
                />
              )
            })}
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
        {abbruch && !busy && (
          <div className="notice warn" style={{ marginBottom: 0 }}>
            Verbindung unterbrochen — die bisherige Antwort bleibt stehen.{' '}
            <button type="button" className="small" onClick={wiederholen}>
              Erneut fragen
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer im Claude-App-Stil: Frage tippen oder diktieren, Pfeil
          sendet — und das Hexcore öffnet den Buddy-Modus (Sprachsitzung). */}
      <form
        className="ki-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        {gesammelt > 0 && (
          <div className="notice info" style={{ marginBottom: 8 }}>
            <span className="led wichtig" style={{ marginRight: 6 }} />
            {gesammelt === 1 ? 'Ein Vorgang' : `${gesammelt} Vorgänge`} aus der Sprachsitzung
            notiert — <a href="/sprechen">prüfen &amp; buchen</a>
            <button
              type="button"
              className="small"
              style={{ marginLeft: 8 }}
              onClick={() => setGesammelt(0)}
            >
              Ausblenden
            </button>
          </div>
        )}
        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Frage an die Daten stellen …"
            disabled={busy}
          />
          <MikrofonKnopf onText={(text) => setInput(text)} titel="Frage diktieren (Deutsch)" />
          {sprechen && (
            <button
              type="button"
              className="composer-knopf buddy"
              title="Buddy-Modus: mit dem ERP sprechen"
              aria-label="Buddy-Modus: mit dem ERP sprechen"
              onClick={buddyStarten}
            >
              <HexcoreMark groesse={19} variante="einfach" />
            </button>
          )}
          <button
            className="composer-knopf senden"
            type="submit"
            disabled={busy || !input.trim()}
            title="Fragen"
            aria-label="Fragen"
          >
            {busy ? <span className="led on" /> : <SendenSymbol />}
          </button>
        </div>
      </form>
    </div>
  )
}
