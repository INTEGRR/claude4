import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { sql } from '@/db/client'
import { SCHEMA_DOKU } from './schema-doku'
import { MAX_ROWS, runReadOnlyQuery } from './sql-tool'

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

const SYSTEM = `Du bist der Datenanalyst im selbstgebauten ERP eines Tastaturherstellers.
Du beantwortest Fragen zu Verkauf, Einkauf, Fertigung, Lager, Reparatur und Versand,
indem du SQL-Abfragen (PostgreSQL, nur lesend) über das Werkzeug sql_abfrage ausführst.

Regeln:
- Antworte auf Deutsch, knapp und mit Zahlen. Ergebnislisten als Markdown-Tabellen.
- Führe lieber mehrere kleine Abfragen aus als eine riesige. Ergebnisse werden bei ${MAX_ROWS} Zeilen gekappt — nutze aggregierende Abfragen und LIMIT.
- Nutze die dokumentierten Hilfsfunktionen (on_hand_qty, variant_display_name, sales_order_total, …) statt Bestände selbst zusammenzurechnen.
- Runde Geldwerte auf 2 Nachkommastellen; nenne die Kostenbasis, wenn du Werte bewertest.
- Wenn eine Frage nicht aus den Daten beantwortbar ist, sage das ehrlich.
${SCHEMA_DOKU}`

const TOOLS: Anthropic.Messages.Tool[] = [
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
      system: SYSTEM,
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
      const query = String((block.input as { query?: string }).query ?? '')
      await onEvent({ type: 'sql', query })
      await onEvent({ type: 'status', text: 'Abfrage läuft …' })
      await sql`select log_event('ki', ${requestId}, 'note', ${'SQL: ' + query.slice(0, 900)}, ${actor})`

      const ergebnis = await runReadOnlyQuery(sql, query)
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
