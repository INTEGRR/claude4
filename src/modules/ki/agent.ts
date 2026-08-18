import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { sql } from '@/db/client'
import { SCHEMA_DOKU, SCHEMA_DOKU_FINANZEN } from './schema-doku'
import { FINANZ_SPERRE, MAX_ROWS, runReadOnlyQuery } from './sql-tool'
import { DIAGRAMM_TOOL, type Diagramm, diagrammSchema } from './diagramm'
import { aktionPruefen, aktionenTool } from './aktionen'
import { aktionPruefen as registryPruefen } from '@/modules/prozesse/torwaechter'
import { kiKatalog } from '@/modules/prozesse/introspektion'

/**
 * KI-Agent für Ad-hoc-Auswertungen: Claude mit genau einem Werkzeug —
 * einer SQL-Abfrage, die in einer Read-only-Transaktion läuft (siehe
 * sql-tool.ts). Schreiben ist damit auf Datenbankebene ausgeschlossen;
 * die Sperrliste hält zusätzlich Geheimnisse (Passwörter, Sitzungen,
 * API-Schlüssel) fern.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5'
const MAX_ROUNDS = 15

export function kiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

// --- Agent -----------------------------------------------------------------

const systemPrompt = (
  finanzen: boolean,
) => `Du bist der Datenanalyst im selbstgebauten ERP eines Tastaturherstellers.
Du beantwortest Fragen zu Verkauf, Einkauf, Fertigung, Lager, Reparatur und Versand${finanzen ? ' sowie Finanzen (Kassenstand, Cashflow, Verträge, Darlehen, Steuern)' : ''},
indem du SQL-Abfragen (PostgreSQL, nur lesend) über das Werkzeug sql_abfrage ausführst.${finanzen ? '' : '\nFür Finanzdaten fehlt dem Fragenden die Berechtigung — sag das ehrlich, statt es zu versuchen.'}

Du hast drei Werkzeuge: sql_abfrage (lesen), diagramm (anzeigen) und
aktion_vorschlagen (anlegen — nur nach Bestätigung durch den Benutzer).

Regeln:
- Antworte auf Deutsch, knapp und mit Zahlen. Ergebnislisten als Markdown-Tabellen.
- Zeig ein Diagramm, wenn es die Aussage trägt: Verläufe über Monate, Ranglisten, Anteile
  an einem Ganzen. Bei zwei, drei Zahlen bleibt es beim Satz. Die Zahlen gehören immer
  zusätzlich in den Text — ein Diagramm ersetzt keine Tabelle, es fasst zusammen.
- Anlegen darfst du nur, was ausdrücklich gewünscht ist, und nur über aktion_vorschlagen.
  Der Vorschlag geht an den Benutzer; erst sein Klick führt ihn aus. Sag danach also nicht,
  etwas sei angelegt — sag, dass die Vorschläge zur Bestätigung bereitliegen. Schlage nie
  ungefragt etwas vor. Viele gleichartige Anlagen (z. B. ein Meldebestand je Produkt)
  gehören alle in EINE Antwort — aktion_vorschlagen mehrfach aufrufen, nicht eine
  Runde je Datensatz.
- Namen und Kennungen (SKU, Kunde, IDs) vor einem Vorschlag mit sql_abfrage nachschlagen,
  statt sie zu raten.
- Führe lieber mehrere kleine Abfragen aus als eine riesige. Ergebnisse werden bei ${MAX_ROWS} Zeilen gekappt — nutze aggregierende Abfragen und LIMIT.
- Nutze die dokumentierten Hilfsfunktionen (on_hand_qty, variant_display_name, sales_order_total, …) statt Bestände selbst zusammenzurechnen.
- Runde Geldwerte auf 2 Nachkommastellen; nenne die Kostenbasis, wenn du Werte bewertest.
- Wenn eine Frage nicht aus den Daten beantwortbar ist, sage das ehrlich.
${SCHEMA_DOKU}${finanzen ? SCHEMA_DOKU_FINANZEN : ''}`

const TOOLS: Anthropic.Messages.Tool[] = [
  DIAGRAMM_TOOL,
  // Eigener KI-Katalog (namensbasierte Anlage-Aktionen) plus alle
  // Registry-Aktionen mit ki-Flag — eine Definition, alle Transporte.
  aktionenTool(kiKatalog()),
  {
    name: 'sql_abfrage',
    description:
      'Führt eine einzelne lesende SQL-Abfrage (PostgreSQL) gegen die ERP-Datenbank aus. ' +
      'Läuft in einer Read-only-Transaktion mit 10s-Timeout; Ergebnisse sind auf ' +
      `${MAX_ROWS} Zeilen begrenzt.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Die SQL-Abfrage (ein Statement, nur lesend).' },
      },
      required: ['query'],
    },
  },
]

export type KiEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string }
  | { type: 'sql'; query: string }
  | { type: 'chart'; chart: Diagramm }
  | {
      type: 'aktion'
      id: string
      aktion: string
      label: string
      bereich: string
      zusammenfassung: string
      begruendung?: string
      parameter: Record<string, unknown>
    }
  | { type: 'error'; text: string }
  | { type: 'done' }

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Führt eine Agenten-Runde aus: streamt Text an onEvent, führt Tool-Aufrufe
 * aus und loggt jede SQL-Abfrage ins audit_log (Nachvollziehbarkeit).
 */
export async function runAgent(
  history: ChatTurn[],
  actor: string,
  onEvent: (ev: KiEvent) => void | Promise<void>,
  // Rechte des Fragenden: Finanzdaten sieht die KI nur, wenn er sie sieht
  // (Admin oder Befugnis finanzen:zugriff) — Schema-Doku UND SQL-Sperre.
  rechte: { finanzen: boolean } = { finanzen: false },
): Promise<void> {
  const client = new Anthropic()
  const requestId = randomUUID()

  const frage = history.at(-1)?.text ?? ''
  await sql`select log_event('ki', ${requestId}, 'note', ${'Frage: ' + frage.slice(0, 500)}, ${actor})`

  // Ältere Runden als reiner Text; die Tool-/Denk-Blöcke der laufenden
  // Anfrage werden innerhalb der Schleife vollständig mitgeführt.
  const messages: Anthropic.Messages.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.text,
  }))

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemPrompt(rechte.finanzen),
      tools: TOOLS,
      messages,
    })

    stream.on('text', (delta) => {
      void onEvent({ type: 'text', text: delta })
    })

    const response = await stream.finalMessage()

    if (response.stop_reason !== 'tool_use') {
      await onEvent({ type: 'done' })
      return
    }

    // Assistant-Blöcke (inkl. Denk-Blöcken) unverändert zurückgeben —
    // Pflicht beim Tool-Einsatz mit adaptivem Denken.
    messages.push({ role: 'assistant', content: response.content })

    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      // --- Diagramm ---------------------------------------------------------
      if (block.name === 'diagramm') {
        const geprueft = diagrammSchema.safeParse(block.input)
        if (!geprueft.success) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content:
              'Diagramm abgelehnt — ' +
              geprueft.error.issues.map((i) => i.message).join('; '),
            is_error: true,
          })
          continue
        }
        await onEvent({ type: 'chart', chart: geprueft.data })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Diagramm wird angezeigt. Nenne die wichtigsten Zahlen zusätzlich im Text.',
        })
        continue
      }

      // --- Schreibende Aktion (nur Vorschlag) -------------------------------
      if (block.name === 'aktion_vorschlagen') {
        const eingabe = block.input as {
          aktion?: string
          parameter?: unknown
          record_id?: string
          begruendung?: string
        }
        try {
          const name = String(eingabe.aktion ?? '')
          let label: string
          let bereich: string
          let zusammenfassung: string
          let werte: Record<string, unknown>
          if (name.includes('.')) {
            // Registry-Aktion: derselbe DB-freie Prüfweg wie der Torwächter;
            // die record_id wandert IM Parameter mit, damit die Bestätigung
            // im Chat sie unverändert an /api/ki/aktion zurückgeben kann.
            const recordId =
              typeof eingabe.record_id === 'string' && eingabe.record_id
                ? eingabe.record_id
                : undefined
            const geprueft = registryPruefen(name, { parameter: eingabe.parameter, recordId })
            label = geprueft.aktion.label
            bereich = geprueft.aktion.bereich
            zusammenfassung =
              geprueft.aktion.zusammenfassung?.(geprueft.werte as never) ?? geprueft.aktion.label
            werte = { ...geprueft.werte, ...(recordId ? { record_id: recordId } : {}) }
          } else {
            const geprueft = aktionPruefen(name, eingabe.parameter)
            label = geprueft.aktion.label
            bereich = geprueft.aktion.bereich
            zusammenfassung = geprueft.aktion.zusammenfassung(geprueft.werte)
            werte = geprueft.werte as Record<string, unknown>
          }
          const id = randomUUID()
          await onEvent({
            type: 'aktion',
            id,
            aktion: name,
            label,
            bereich,
            zusammenfassung,
            begruendung: eingabe.begruendung,
            parameter: werte,
          })
          await sql`select log_event('ki', ${requestId}, 'note',
            ${'Aktion vorgeschlagen: ' + String(eingabe.aktion)}, ${actor})`
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content:
              'Der Vorschlag liegt dem Benutzer zur Bestätigung vor. Führe nichts weiter aus ' +
              'und behaupte nicht, es sei bereits angelegt — sage kurz, was er bestätigen soll.',
          })
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: err instanceof Error ? err.message : 'Aktion abgelehnt',
            is_error: true,
          })
        }
        continue
      }

      // --- SQL --------------------------------------------------------------
      const query = String((block.input as { query?: string }).query ?? '')
      await onEvent({ type: 'sql', query })
      await onEvent({ type: 'status', text: 'Abfrage läuft …' })
      await sql`select log_event('ki', ${requestId}, 'note', ${'SQL: ' + query.slice(0, 900)}, ${actor})`

      const ergebnis = await runReadOnlyQuery(
        sql,
        query,
        rechte.finanzen ? undefined : FINANZ_SPERRE,
      )
      const content = ergebnis.error
        ? `Fehler: ${ergebnis.error}`
        : JSON.stringify({
            zeilen: ergebnis.rowCount,
            ...(ergebnis.gekappt ? { hinweis: `auf ${MAX_ROWS} Zeilen gekappt` } : {}),
            daten: ergebnis.rows,
          })
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        ...(ergebnis.error ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: results })
  }

  await onEvent({
    type: 'error',
    text: 'Abbruch: zu viele Abfragerunden. Bitte die Frage eingrenzen.',
  })
  await onEvent({ type: 'done' })
}
