import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import type { Role } from '@/modules/auth/permissions'
import { canAccess } from '@/modules/auth/permissions'
import { SCHEMA_DOKU, SCHEMA_DOKU_FINANZEN } from './schema-doku'
import { kiModell } from './modelle'
import { FINANZ_SPERRE, MAX_ROWS, runReadOnlyQuery } from './sql-tool'

/**
 * Datenfrage-Fallback des Sprachmodus: eine kurze, nicht streamende
 * Modellrunde (Muster /api/ki/aktion/aendern) beantwortet komplexe Fragen
 * über Read-only-SQL — bewusst ein KLEINES, schnelles Modell, denn am
 * anderen Ende wartet jemand mit dem Ohr am Gespräch. Das Sprachmodell
 * liest die Antwort danach nur vor.
 */

const MAX_RUNDEN = 4

export function datenfrageKonfiguriert(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export async function datenfrageBeantworten(
  frage: string,
  nutzer: { name: string; role: Role; befugnisse?: readonly string[] },
): Promise<string> {
  if (!datenfrageKonfiguriert()) {
    return 'Datenfragen sind nicht konfiguriert (ANTHROPIC_API_KEY fehlt).'
  }
  // Finanzdaten nur, wenn der Fragende sie auch am Bildschirm sehen dürfte
  // (Admin oder Befugnis finanzen:zugriff) — Schema-Doku UND SQL-Sperre.
  const finanzen = canAccess(nutzer.role, 'finanzen', nutzer.befugnisse ?? [])

  const client = new Anthropic()
  const modell = await kiModell(sql, 'datenfrage')
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: frage }]

  for (let runde = 0; runde < MAX_RUNDEN; runde++) {
    let antwort: Anthropic.Messages.Message
    try {
      antwort = await client.messages.create({
        model: modell,
        max_tokens: 2000,
        system:
          'Du beantwortest EINE Datenfrage aus einem ERP für eine Sprachausgabe. ' +
          'Frage die Datenbank über `sql_abfrage` (nur SELECT) ab und antworte dann in ' +
          'höchstens drei kurzen deutschen Sätzen mit den konkreten Zahlen — keine ' +
          'Tabellen, keine Aufzählungen, keine SQL-Erklärungen. Runde Beträge sinnvoll.' +
          (finanzen
            ? ''
            : ' Für Finanzdaten fehlt dem Fragenden die Berechtigung — sag das ehrlich.') +
          '\n\n' +
          SCHEMA_DOKU +
          (finanzen ? SCHEMA_DOKU_FINANZEN : ''),
        tools: [
          {
            name: 'sql_abfrage',
            description: `Führt ein Read-only-SQL aus (max. ${MAX_ROWS} Zeilen).`,
            input_schema: {
              type: 'object' as const,
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
        messages,
      })
    } catch (err) {
      return `Die Datenfrage ist fehlgeschlagen: ${err instanceof Error ? err.message : 'KI nicht erreichbar'}`
    }

    const toolUse = antwort.content.find((b) => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      const text = antwort.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      return text || 'Dazu habe ich keine Antwort gefunden.'
    }

    const query = String((toolUse.input as { query?: unknown }).query ?? '')
    const ergebnis = await runReadOnlyQuery(sql, query, finanzen ? undefined : FINANZ_SPERRE)
    await sql`select log_event('ki', gen_random_uuid(), 'state',
      ${`Datenfrage (Sprachmodus): ${query.slice(0, 200)}`}, ${nutzer.name})`

    messages.push({ role: 'assistant', content: antwort.content })
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(ergebnis).slice(0, 20000),
          ...(ergebnis.error ? { is_error: true } : {}),
        },
      ],
    })
  }

  return 'Die Datenfrage war zu vielschichtig — bitte am Bildschirm in der KI-Analyse stellen.'
}
