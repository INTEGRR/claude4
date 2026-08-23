import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { PROZESS_WISSEN, bausteineAlsText } from './wissen'

/**
 * Das geführte Text-Interview der Ersteinrichtung: die KI stellt WIRKLICH
 * die nächste Frage (mit Rückfragen, Zwischenbilanz und anklickbaren
 * Kurzantworten), statt vier starre Fragen abzuspulen. Der Abschluss bleibt
 * deterministisch: die gesammelten Runden gehen unverändert an
 * aufnahmeStrukturieren → einstellungen.prozess_entwerfen — dieses Modul
 * ENTWIRFT nichts, es fragt nur.
 *
 * Bewusst eine eigene, schlanke Maschine statt des Chat-Agenten: kein
 * sql_abfrage, kein diagramm, kein aktion_vorschlagen — im Onboarding wäre
 * das die falsche Werkzeugfläche. Eine Runde = ein kleiner Aufruf mit
 * erzwungenem Werkzeug, ~1 s statt einer Agenten-Schleife.
 */

const MODELL = process.env.AUFNAHME_MODELL ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-5'
const MAX_RUNDEN = 10

export interface InterviewErgebnis {
  frage: string
  /** Anklickbare Kurzantworten — „Passt so", konkrete Feldnamen, … */
  optionen: string[]
  fertig: boolean
}

/** System-Anleitung — pur exportiert, damit der Wächter-Test sie prüfen kann. */
export function interviewSystem(firma: string): string {
  return (
    `Du führst für das ERP von ${firma} das Aufnahme-Interview der Ersteinrichtung: ` +
    'Der Kunde erzählt einen IST-Prozess, du stellst die jeweils NÄCHSTE Frage. ' +
    'Deutsch, freundlich, kurze Sätze — und immer nur EINE Frage.\n\n' +
    'SO WENIG EINGABE WIE MÖGLICH: Erkennst du einen der Standard-Bausteine unten ' +
    '(oder einen ähnlichen Typ), SCHLAGE Schritte und Felder aktiv vor und lass ' +
    'bestätigen oder streichen — frag nicht ab, was branchenüblich klar ist. Gib zu ' +
    'jeder Frage, wo es geht, 2–4 kurze Antwort-OPTIONEN zum Anklicken mit ' +
    '(z. B. „Passt so", „Ohne Skonto", konkrete Feld- oder Schrittnamen). ' +
    'Freitext bleibt immer möglich.\n\n' +
    'WAS AM ENDE DA SEIN MUSS: Auslöser · Schritte in Reihenfolge · Entscheidungen ' +
    '(und wonach) · Zuständigkeiten · Ausnahmen/Abbruchwege · FELDER (was wird wo ' +
    'eingetragen — Leitfrage „Was tragen Sie in diesem Schritt ein?"). Fasse ' +
    'zwischendurch kurz zusammen („Bisher habe ich: …").\n\n' +
    `SCHLUSS: Sobald alles beisammen ist — spätestens nach ${MAX_RUNDEN} Runden — ` +
    'setze fertig=true und formuliere als frage eine Ein-Satz-Zusammenfassung des ' +
    'Ablaufs samt der vorgeschlagenen Felder. Danach zeichnet das System den ' +
    'Entwurf; korrigiert wird bei der Abnahme.\n\n' +
    `${PROZESS_WISSEN}\n\n## Standard-Bausteine (Vorlagen — vorschlagen, nicht abfragen)\n\n${bausteineAlsText()}`
  )
}

const WERKZEUG: Anthropic.Messages.Tool = {
  name: 'naechste_frage',
  description: 'Liefert die nächste Interviewfrage (oder den Abschluss).',
  input_schema: {
    type: 'object' as const,
    properties: {
      frage: {
        type: 'string',
        description: 'Die nächste Frage — bei fertig=true die Ein-Satz-Zusammenfassung.',
      },
      optionen: {
        type: 'array',
        items: { type: 'string' },
        description: '2–4 kurze anklickbare Antworten; leer, wenn Freitext nötig ist.',
      },
      fertig: {
        type: 'boolean',
        description: 'true = genug erhoben, der Entwurf kann gezeichnet werden.',
      },
    },
    required: ['frage', 'fertig'],
  },
}

export async function interviewRunde(
  runden: { frage: string; antwort: string }[],
  firma: string,
): Promise<InterviewErgebnis> {
  // Harte Obergrenze unabhängig vom Modell — ein Interview, das nie endet,
  // wäre das Gegenteil von „so einfach wie möglich".
  if (runden.length >= MAX_RUNDEN) {
    return { frage: 'Danke — das reicht für den ersten Entwurf.', optionen: [], fertig: true }
  }

  const transkript = runden
    .map((r) => `Assistent: ${r.frage}\nKunde: ${r.antwort}`)
    .join('\n\n')

  const client = new Anthropic()
  const antwort = await client.messages.create({
    model: MODELL,
    max_tokens: 700,
    system: interviewSystem(firma),
    tools: [WERKZEUG],
    tool_choice: { type: 'tool', name: 'naechste_frage' },
    messages: [
      {
        role: 'user',
        content: `Bisheriges Interview (Runde ${runden.length}):\n\n${transkript.slice(0, 40_000)}`,
      },
    ],
  })

  const toolUse = antwort.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  )
  const roh = (toolUse?.input ?? {}) as { frage?: unknown; optionen?: unknown; fertig?: unknown }
  const frage =
    typeof roh.frage === 'string' && roh.frage.trim()
      ? roh.frage.trim().slice(0, 600)
      : 'Was gehört noch zu diesem Ablauf?'
  const optionen = Array.isArray(roh.optionen)
    ? roh.optionen
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .slice(0, 4)
        .map((o) => o.trim().slice(0, 80))
    : []
  return { frage, optionen, fertig: roh.fertig === true }
}
