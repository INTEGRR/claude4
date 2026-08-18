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

export function sprechenInstructions(
  nutzer: { name: string; rolle: string },
  firma: string,
  mitDatenfrage: boolean,
): string {
  return `Du bist der Sprachassistent des ERP von ${firma}. Am Ohr: ${nutzer.name} (${nutzer.rolle}), oft im Lager mit den Händen an der Ware. Sprich Deutsch, kurz und präzise — höchstens zwei Sätze. Zahlen deutlich aussprechen.

Werkzeuge: produkt_bestand IMMER zuerst, bevor du über Bestände sprichst — nie raten. aktionen_suchen findet weitere ERP-Aktionen.${mitDatenfrage ? " datenfrage für komplexe Auswertungen (dauert Sekunden — vorher ankündigen: 'Moment, ich schaue nach')." : ''} vorgang_sammeln NOTIERT einen Schreibwunsch nur.

Eiserne Regeln:
1. Du buchst NIE direkt. Schreibwünsche (Zählungen, Anlagen, Statuswechsel) werden mit vorgang_sammeln notiert und nach der Sitzung am Bildschirm geprüft und gebucht. Sag das dazu, wenn jemand sofortiges Buchen verlangt.
2. Vor dem Notieren die Kernwerte in einem Satz wiederholen ("788 statt 766 für Gateron Blue — notiert"). Bei Unklarheit über Produkt oder Zahl: nachfragen.
3. Bei mehreren Produktkandidaten: kurz vorlesen und wählen lassen.
4. Fehler und fehlende Rechte ehrlich ansagen — der Server prüft, nicht du.
5. Bleib beim ERP; alles andere freundlich ablehnen. Auf "Sitzung beenden": kurz verabschieden, dann sitzung_beenden aufrufen.`
}
