import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import type { User } from '@/modules/auth'
import { REGISTRY } from '@/modules/prozesse/registry'
import { bestaetigteAktionAusfuehren } from './aktion-bestaetigt'
import { PROZESS_WISSEN } from './wissen'

/**
 * Prozess-Aufnahme beim Kunden: das Realtime-Modell führt das INTERVIEW
 * (kurze Rückfragen, Zwischenzusammenfassungen), dieses Modul macht danach
 * den schweren Teil — es strukturiert das Gesprächstranskript in einen
 * `einstellungen.prozess_entwerfen`-Aufruf. Ergebnis ist IMMER nur ein
 * ENTWURF (inaktive Prozessversion): die Sichtprüfung ist das Diagramm auf
 * /prozesse/<code>, aktiviert wird bewusst von Hand.
 *
 * Arbeitsteilung nach Stärke: Realtime spricht natürlich, Claude baut das
 * strenge Schema. Validiert der Torwächter den Entwurf nicht, bekommt das
 * Modell den Fehler zurück und darf nachbessern (max. 3 Runden).
 */

const MODELL = process.env.AUFNAHME_MODELL ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-5'
const MAX_RUNDEN = 3

export function aufnahmeKonfiguriert(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/** System-Anleitung der Strukturierung — pur, damit der Test sie prüfen kann. */
export function aufnahmeSystem(wissen: string = PROZESS_WISSEN): string {
  // Die Registry-Beschreibung ist die EINE Wahrheit darüber, wie ein
  // Entwurf auszusehen hat — sie wird mitgegeben statt hier dupliziert.
  const beschreibung = REGISTRY['einstellungen.prozess_entwerfen'].beschreibung ?? ''
  return (
    'Du strukturierst das Transkript eines Kundeninterviews in EINEN ' +
    'Ist-Prozess und reichst ihn über das Werkzeug prozess_entwerfen ein. ' +
    'Es entsteht nur ein ENTWURF — nichts wird aktiv.\n\n' +
    'Regeln für Ist-Prozesse von Kunden: modell IMMER "vorgang" (frei ' +
    'definierte Zustände, kein Code nötig). Erster Schritt nach start: ' +
    'vorgang.anlegen mit params {"prozess_code": "<code>"}. Jeder weitere ' +
    'Arbeitsschritt: art "aktion" mit vorgang.status_setzen, params ' +
    '{"state": "<zustand>"} und demselben Wert als zustand. Entscheidungen ' +
    'werden als xor-Schritt mit bedingten Übergängen abgebildet. Nimm die ' +
    'Sprache des Kunden für Namen und Zustände; erfinde nichts, was im ' +
    'Transkript nicht vorkommt — lieber weniger Schritte als erfundene. ' +
    'Wähle einen kurzen, sprechenden code (Kleinbuchstaben/Unterstriche) ' +
    'und den Bereich, der fachlich am besten passt.\n\n' +
    wissen +
    '\n\nMaßgeblich für Struktur und Pflichtfelder ist die folgende ' +
    'Aktionsbeschreibung:\n' +
    beschreibung
  )
}

/** Grobes JSON-Schema fürs Modell — die harte Validierung macht der Torwächter (zod). */
const WERKZEUG: Anthropic.Messages.Tool = {
  name: 'prozess_entwerfen',
  description: 'Reicht den strukturierten Prozess als Entwurf ein.',
  input_schema: {
    type: 'object' as const,
    properties: {
      code: { type: 'string', description: 'kurz, kleinbuchstaben_mit_unterstrichen' },
      name: { type: 'string' },
      beschreibung: { type: 'string' },
      bereich: { type: 'string' },
      modell: { type: 'string', description: "für Kunden-Ist-Prozesse: 'vorgang'" },
      schritte: { type: 'array', items: { type: 'object' } },
      uebergaenge: { type: 'array', items: { type: 'object' } },
    },
    required: ['code', 'name', 'bereich', 'schritte', 'uebergaenge'],
  },
}

export async function aufnahmeStrukturieren(
  transkript: string,
  titel: string,
  nutzer: User,
): Promise<string> {
  if (!aufnahmeKonfiguriert()) {
    return 'Die Prozess-Aufnahme ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).'
  }
  if (transkript.trim().length < 80) {
    return 'Das Gespräch war zu kurz für einen Prozessentwurf — bitte den Ablauf ausführlicher besprechen.'
  }

  const client = new Anthropic()
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content:
        `Arbeitstitel des Prozesses: ${titel}\n\n` +
        `Interview-Transkript (Nutzer = Berater/Kunde, Assistent = Interviewer):\n` +
        transkript.slice(0, 60_000),
    },
  ]

  for (let runde = 0; runde < MAX_RUNDEN; runde++) {
    let antwort: Anthropic.Messages.Message
    try {
      antwort = await client.messages.create({
        model: MODELL,
        max_tokens: 8000,
        system: aufnahmeSystem(),
        tools: [WERKZEUG],
        tool_choice: { type: 'tool', name: 'prozess_entwerfen' },
        messages,
      })
    } catch (err) {
      return `Die Strukturierung ist fehlgeschlagen: ${err instanceof Error ? err.message : 'KI nicht erreichbar'}`
    }

    const toolUse = antwort.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    )
    if (!toolUse) return 'Die Strukturierung hat keinen Entwurf geliefert — bitte erneut versuchen.'

    try {
      // Derselbe geprüfte Weg wie jede KI-Aktion: Torwächter validiert
      // (zod, Rechte, nurAdmin), log_event protokolliert.
      const ergebnis = await bestaetigteAktionAusfuehren(
        'einstellungen.prozess_entwerfen',
        toolUse.input,
        nutzer,
      )
      const code = String((toolUse.input as { code?: unknown }).code ?? '')
      await sql`select log_event('ki', gen_random_uuid(), 'state',
        ${`Prozess-Aufnahme: Entwurf ${code} aus Sprachinterview`}, ${nutzer.name})`
      return (
        `${ergebnis.text} Das Diagramm steht unter /prozesse/${code} zur Sichtprüfung — ` +
        'aktiviert wird dort von Hand, bis dahin ist nichts in Betrieb.'
      )
    } catch (err) {
      // Validierungs-/Fachfehler zurück ans Modell — es darf nachbessern.
      const meldung = err instanceof Error ? err.message : String(err)
      messages.push({ role: 'assistant', content: antwort.content })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Abgelehnt: ${meldung}. Bitte korrigiert erneut einreichen.`,
            is_error: true,
          },
        ],
      })
    }
  }

  return 'Der Entwurf wurde mehrfach abgelehnt — bitte am Bildschirm in der KI-Analyse fortsetzen.'
}
