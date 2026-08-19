import { z } from 'zod'

/**
 * Werkzeugkatalog + Instructions des Sprachmodus — bewusst DB-frei (Konvention
 * wie aktionen.ts), damit alles unter blankem Node testbar ist.
 *
 * Grundsatz des Modus: LESEN antwortet live (produkt_bestand, aktionen_suchen,
 * datenfrage), SCHREIBEN wird nur GESAMMELT (vorgang_sammeln) — gebucht wird
 * erst nach der Sichtprüfung in der Tabelle auf /sprechen. Die Instructions
 * sind absichtlich kurz (~1,2k Zeichen): jedes Zeichen läuft bei Realtime als
 * Input-Token in jede Runde.
 */

export interface RealtimeWerkzeug {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Datachannel-Eventnamen an EINER Stelle — die API benennt gelegentlich um. */
export const DC_EVENTS = {
  /** Server → Client: fertiger Function-Call. */
  functionCallDone: 'response.function_call_arguments.done',
  /** Server → Client: fertiges Transkript der Nutzer-Spracheingabe. */
  nutzerTranskript: 'conversation.item.input_audio_transcription.completed',
  /** Server → Client: fertiges Transkript der Modell-Antwort. */
  assistentTranskript: 'response.output_audio_transcript.done',
  /** Server → Client: Sprachaktivität des Nutzers erkannt/beendet. */
  sprichtStart: 'input_audio_buffer.speech_started',
  sprichtEnde: 'input_audio_buffer.speech_stopped',
  /** Server → Client: Modell-Antwort läuft/fertig (fürs Hexcore). */
  antwortStart: 'response.created',
  antwortEnde: 'response.done',
  /** Server → Client: abgelehntes Event/API-Fehler — sichtbar machen statt schlucken. */
  apiFehler: 'error',
  /** Client → Server: Function-Ergebnis + neue Antwort anstoßen. */
  itemCreate: 'conversation.item.create',
  responseCreate: 'response.create',
} as const

/** zod-Schemata der Werkzeug-Argumente — der Dispatcher validiert damit. */
export const ARGUMENTE = {
  produkt_bestand: z.object({
    suchbegriff: z.string().min(2, 'Suchbegriff zu kurz'),
  }),
  vorgang_sammeln: z.object({
    aktion: z.string().min(1),
    parameter: z.record(z.string(), z.unknown()),
    zusammenfassung: z.string().min(3).max(300),
    record_id: z.string().uuid().optional(),
  }),
  aktionen_suchen: z.object({
    begriff: z.string().min(2),
  }),
  datenfrage: z.object({
    frage: z.string().min(5),
  }),
  // Wird CLIENTSEITIG behandelt (Verbindung trennen) — die Server-Weiche
  // existiert nur als Rückfallebene.
  sitzung_beenden: z.object({}),
  // Aufnahme-Modus: schließt das Interview ab — der Server strukturiert das
  // Transkript in einen prozess_entwerfen-ENTWURF (nichts wird aktiv).
  aufnahme_abschliessen: z.object({
    titel: z.string().min(3).max(120),
  }),
} as const

export type WerkzeugName = keyof typeof ARGUMENTE

export function sprechenWerkzeuge(mitDatenfrage: boolean): RealtimeWerkzeug[] {
  const werkzeuge: RealtimeWerkzeug[] = [
    {
      type: 'function',
      name: 'produkt_bestand',
      description:
        'Findet ein Produkt (unscharfe Suche über Name, SKU, Barcode) und liefert den Lagerbestand. Bei mehreren Treffern kommt eine Kandidatenliste — dann kurz nachfragen, welches gemeint ist.',
      parameters: {
        type: 'object',
        properties: {
          suchbegriff: {
            type: 'string',
            description: "Gesprochener Produktname, z. B. 'Switches Gateron Blue'",
          },
        },
        required: ['suchbegriff'],
      },
    },
    {
      type: 'function',
      name: 'vorgang_sammeln',
      description:
        'NOTIERT einen Schreibwunsch (Zählung, Anlage, Statuswechsel) in der Sammelliste der Sitzung. Es wird NICHTS gebucht — die Liste wird nach der Sitzung am Bildschirm geprüft und dann gebucht. Für Inventurzählungen: aktion "lager.zaehlung_erfassen" mit parameter {variant_id, counted_qty}; die variant_id vorher über produkt_bestand ermitteln.',
      parameters: {
        type: 'object',
        properties: {
          aktion: { type: 'string', description: 'Aktionsname, z. B. lager.zaehlung_erfassen' },
          parameter: { type: 'object', description: 'Parameter der Aktion' },
          zusammenfassung: {
            type: 'string',
            description: 'Ein kurzer deutscher Satz, was notiert wird — wie angesagt',
          },
          record_id: {
            type: 'string',
            description: 'Beleg-ID, falls die Aktion an einen Beleg gebunden ist',
          },
        },
        required: ['aktion', 'parameter', 'zusammenfassung'],
      },
    },
    {
      type: 'function',
      name: 'aktionen_suchen',
      description:
        'Findet weitere ERP-Aktionen (anlegen, buchen, freigeben, stornieren …) zum Stichwort und liefert Name, Beschreibung und Felder — für vorgang_sammeln.',
      parameters: {
        type: 'object',
        properties: { begriff: { type: 'string' } },
        required: ['begriff'],
      },
    },
  ]
  if (mitDatenfrage) {
    werkzeuge.push({
      type: 'function',
      name: 'datenfrage',
      description:
        "Beantwortet komplexe Datenfragen (Auswertungen, Vergleiche, Verläufe) über die ERP-Datenbank. Dauert mehrere Sekunden — vorher ankündigen ('Moment, ich schaue nach').",
      parameters: {
        type: 'object',
        properties: { frage: { type: 'string' } },
        required: ['frage'],
      },
    })
  }
  werkzeuge.push({
    type: 'function',
    name: 'sitzung_beenden',
    description:
      'Beendet die Sprachsitzung — aufrufen, NACHDEM du dich kurz verabschiedet hast, wenn der Nutzer die Sitzung beenden will.',
    parameters: { type: 'object', properties: {}, required: [] },
  })
  return werkzeuge
}

/**
 * Werkzeuge des AUFNAHME-Modus (Prozess-Aufnahme beim Kunden): bewusst nur
 * zwei — das Modell soll interviewen, nicht im ERP hantieren. Den schweren
 * Teil (Transkript → Entwurf) macht der Server nach dem Abschluss.
 */
export function aufnahmeWerkzeuge(): RealtimeWerkzeug[] {
  return [
    {
      type: 'function',
      name: 'aufnahme_abschliessen',
      description:
        'Schließt die Prozess-Aufnahme ab: das Gespräch wird zu einem Prozess-ENTWURF ' +
        'strukturiert (nichts wird aktiv). Erst aufrufen, wenn der Ablauf vollständig ' +
        'besprochen und zusammengefasst wurde. Dauert eine Weile — vorher ankündigen.',
      parameters: {
        type: 'object',
        properties: {
          titel: {
            type: 'string',
            description: "Arbeitstitel des Prozesses, z. B. 'Reklamation Endkunde'",
          },
        },
        required: ['titel'],
      },
    },
    {
      type: 'function',
      name: 'sitzung_beenden',
      description:
        'Beendet die Sprachsitzung — aufrufen, NACHDEM du dich kurz verabschiedet hast.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ]
}

export function aufnahmeInstructions(nutzer: { name: string }, firma: string): string {
  return `Du nimmst für das ERP von ${firma} einen IST-Prozess auf — ${nutzer.name} sitzt beim Kunden, ihr sprecht zu dritt. Deutsch, freundlich, kurze Sätze.

DU FÜHRST DAS INTERVIEW: Was löst den Prozess aus? Welche Schritte folgen, in welcher Reihenfolge, wer macht sie? Wo wird entschieden (und wonach)? Wie endet er — auch die Abbruchwege? Frag nach Ausnahmen ("Was passiert, wenn …?"). IMMER nur eine Frage auf einmal.

ZWISCHENBILANZ: Fasse nach jedem Abschnitt kurz zusammen ("Bisher habe ich: …") und lass es bestätigen oder korrigieren. Nimm die Worte des Kunden — keine ERP-Begriffe erzwingen, nichts dazuerfinden.

ABSCHLUSS: Wenn der Ablauf vollständig ist, fasse ihn einmal komplett zusammen. Erst nach Bestätigung: ankündigen, dass der Entwurf gezeichnet wird ("Einen Moment, ich zeichne das auf"), dann aufnahme_abschliessen mit einem Arbeitstitel aufrufen. Es entsteht NUR ein Entwurf — geprüft und aktiviert wird am Bildschirm, sag das dazu. Auf "Sitzung beenden": verabschieden, dann sitzung_beenden.`
}

/**
 * Whisper halluziniert bei Stille/Atemgeräuschen notorische Untertitel-
 * Floskeln aus seinen Trainingsdaten („Untertitel der Amara.org-Community",
 * „Copyright WDR" …). Solche Zeilen fliegen aus Log und Protokoll — das
 * Sprachmodell hört das Audio direkt und ist davon ohnehin unberührt.
 */
const HALLUZINATIONEN = [
  /untertitel/i,
  /amara\.org/i,
  /\b(zdf|wdr|ndr|ard|swr|br|funk)\b/i,
  /copyright/i,
  /vielen dank f(ü|ue)rs? zuschauen/i,
  /abonniert|abonnieren/i,
]

export function istTranskriptHalluzination(text: string): boolean {
  return HALLUZINATIONEN.some((muster) => muster.test(text))
}

export function sprechenInstructions(
  nutzer: { name: string; rolle: string },
  firma: string,
  mitDatenfrage: boolean,
): string {
  return `Du bist der Sprachassistent des ERP von ${firma}. Am Ohr: ${nutzer.name} (${nutzer.rolle}), oft im Lager, die Hände an der Ware. Deutsch, knapp: EIN Satz, wenn er reicht, nie mehr als zwei. Zahlen deutlich aussprechen.

ERST HANDELN, DANN REDEN: Lesefragen beantwortest du sofort per Werkzeug — keine Rückfrage, wenn ein sinnvoller Versuch möglich ist. produkt_bestand für den Bestand einer Ware.${mitDatenfrage ? ' datenfrage für ALLES andere Lesbare (Wareneingänge, Termine, "wann kommt X", Überfälliges, Auswertungen) — formuliere die Frage dort präzise mitsamt dem, was der Nutzer wirklich wissen will (fragt er nach Switches, frag nach Switches, nicht allgemein). Kurz ankündigen: "Moment, ich schaue nach."' : ''} Rückfragen nur bei Schreibwünschen mit unklarem Produkt oder unklarer Zahl.

ZIEL FESTHALTEN: Der erste Wunsch des Nutzers ist dein roter Faden. Fragt er nach Switches, filterst du JEDE Antwort auf Switches, bis er das Thema wechselt. Beantworte immer zuerst die gestellte Frage — Beifang weglassen.

Du buchst NIE direkt: Schreibwünsche (Zählungen, Anlagen, Statuswechsel) werden mit vorgang_sammeln nur NOTIERT und nach der Sitzung am Bildschirm geprüft und gebucht — sag das, wenn jemand sofort buchen will. Vor dem Notieren die Kernwerte in einem Satz wiederholen ("788 statt 766 für Gateron Blue — notiert"). Bei mehreren Produktkandidaten kurz wählen lassen. Fehler und fehlende Rechte ehrlich ansagen — der Server prüft, nicht du. Bleib beim ERP. Auf "Sitzung beenden": kurz verabschieden, dann sitzung_beenden aufrufen.`
}
