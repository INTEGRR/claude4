import { z } from 'zod'
import type { Area } from '@/modules/auth/permissions'

/**
 * Was der KI-Agent anlegen darf — der Katalog, ohne Datenbankzugriff.
 *
 * Grundsatz: Der Agent schreibt **kein** SQL. Er wählt eine Aktion aus diesem
 * Katalog und füllt deren Felder; ausgeführt wird sie in
 * `aktionen-ausfuehren.ts` mit denselben Funktionen, die auch die Oberfläche
 * benutzt. Damit gelten Belegnummernkreise, Prüfungen und Buchungslogik
 * unverändert.
 *
 * Diese Datei bleibt bewusst frei von Datenbank- und Server-Importen: der
 * Agent muss nur *vorschlagen* können, und die Prüfung soll ohne laufende
 * Datenbank testbar sein. Ausführen kann nur, wer zusätzlich die
 * Ausführungsdatei lädt — und das tut allein die bestätigte Route.
 *
 * Jede Aktion nennt ihren Bereich; ausgeführt wird nur, wenn die Rolle dort
 * schreiben darf, und erst nachdem der Benutzer im Chat bestätigt hat.
 */

export interface AktionErgebnis {
  text: string
  link?: string
}

export interface Aktion<S extends z.ZodTypeAny = z.ZodTypeAny> {
  label: string
  bereich: Area
  beschreibung: string
  schema: S
  /** Menschenlesbare Zusammenfassung für die Bestätigung. */
  zusammenfassung: (p: z.infer<S>) => string
}

export const UUID_MUSTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const geld = (v: number) => v.toFixed(2).replace('.', ',') + ' €'

export const positionSchema = z.object({
  produkt: z.string().min(1).describe('SKU, Barcode, Name oder ID der Variante'),
  menge: z.number().positive(),
  preis: z.number().nonnegative().optional().describe('Netto je Einheit; leer = Listenpreis'),
})
type Position = z.infer<typeof positionSchema>

interface Attribut {
  name: string
  werte: { name: string; aufpreis?: number; kuerzel?: string; farbe?: string }[]
}

// --- Katalog ---------------------------------------------------------------

export const AKTIONEN = {
  kontakt_anlegen: {
    label: 'Kontakt anlegen',
    bereich: 'kontakte',
    beschreibung: 'Legt einen Kunden und/oder Lieferanten an.',
    schema: z.object({
      name: z.string().min(1).max(200),
      kunde: z.boolean().default(true),
      lieferant: z.boolean().default(false),
      firma: z.boolean().default(true),
      email: z.string().email().optional(),
      telefon: z.string().max(60).optional(),
      strasse: z.string().max(120).optional(),
      hausnummer: z.string().max(20).optional(),
      plz: z.string().max(12).optional(),
      ort: z.string().max(80).optional(),
      land: z.string().length(2).optional().describe('ISO-Code, z. B. DE'),
    }),
    zusammenfassung: (p) =>
      `${p.name} — ${[p.kunde && 'Kunde', p.lieferant && 'Lieferant'].filter(Boolean).join(' und ') || 'Kontakt'}` +
      (p.ort ? `, ${`${p.plz ?? ''} ${p.ort}`.trim()}` : ''),
  },

  verkaufsauftrag_anlegen: {
    label: 'Verkaufsauftrag anlegen',
    bereich: 'verkauf',
    beschreibung:
      'Legt ein Angebot (Status Entwurf) für einen bestehenden Kunden an. Der Auftrag wird ' +
      'NICHT bestätigt — das bleibt ein bewusster Schritt in der Oberfläche.',
    schema: z.object({
      kunde: z.string().min(1).describe('Name oder ID eines vorhandenen Kunden'),
      positionen: z.array(positionSchema).min(1).max(50),
      hinweis: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      `Angebot für ${p.kunde} mit ${p.positionen.length} Position(en): ` +
      p.positionen.map((z: Position) => `${z.menge} × ${z.produkt}`).join(', '),
  },

  bestellung_anlegen: {
    label: 'Bestellung anlegen',
    bereich: 'einkauf',
    beschreibung:
      'Legt eine Bestellung im Entwurf bei einem vorhandenen Lieferanten an. Wird nicht bestätigt.',
    schema: z.object({
      lieferant: z.string().min(1),
      positionen: z.array(positionSchema).min(1).max(50),
      hinweis: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      `Bestellung bei ${p.lieferant} mit ${p.positionen.length} Position(en): ` +
      p.positionen.map((z: Position) => `${z.menge} × ${z.produkt}`).join(', '),
  },

  fertigungsauftrag_anlegen: {
    label: 'Fertigungsauftrag anlegen',
    bereich: 'fertigung',
    beschreibung:
      'Legt einen Fertigungsauftrag im Entwurf an. Die Stückliste wird dabei aufgelöst und ' +
      'der Komponentenbedarf eingefroren.',
    schema: z.object({
      produkt: z.string().min(1),
      menge: z.number().positive(),
    }),
    zusammenfassung: (p) => `${p.menge} × ${p.produkt} fertigen`,
  },

  produkt_anlegen: {
    label: 'Produkt anlegen',
    bereich: 'produkte',
    beschreibung:
      'Legt ein Produkt an — mit Attributen entsteht daraus sofort die komplette ' +
      'Variantenmatrix (z. B. 3 Farben × 4 Schaltertypen = 12 Varianten). Fehlende Attribute ' +
      'und Attributwerte werden dabei mit angelegt, vorhandene wiederverwendet (Abgleich über ' +
      'den Namen). Taugt auch für Einkaufsteile: verkaufbar=false, einkaufbar=true.',
    schema: z.object({
      name: z.string().min(1).max(200),
      verkaufspreis: z.number().nonnegative().optional().describe('Listenpreis netto'),
      einstandspreis: z.number().nonnegative().optional().describe('Plankosten je Stück'),
      gewicht_g: z.number().nonnegative().max(1_000_000).optional(),
      verkaufbar: z.boolean().default(true),
      einkaufbar: z.boolean().default(false),
      route: z.enum(['kaufen', 'fertigen']).optional(),
      sku: z
        .string()
        .max(40)
        .optional()
        .describe('Artikelnummer; mit Attributen als Präfix, ergänzt um die Kürzel je Wert'),
      beschreibung: z.string().max(500).optional().describe('Belegtext Verkauf'),
      attribute: z
        .array(
          z.object({
            name: z.string().min(1).max(60).describe('z. B. Farbe oder Switch'),
            werte: z
              .array(
                z.object({
                  name: z.string().min(1).max(60),
                  aufpreis: z.number().optional().describe('Aufschlag auf den Listenpreis'),
                  kuerzel: z.string().max(8).optional().describe('für die SKU, z. B. BK'),
                  farbe: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als Hex-Wert, z. B. #1a1a1a')
                    .optional(),
                }),
              )
              .min(1)
              .max(40),
          }),
        )
        .max(3)
        .default([])
        .describe('Höchstens drei Attribute — die Matrix wächst multiplikativ'),
    }).refine(
      (p) => p.attribute.reduce((n, a) => n * a.werte.length, 1) <= 200,
      { message: 'Mehr als 200 Varianten — bitte die Attributwerte eingrenzen', path: ['attribute'] },
    ),
    zusammenfassung: (p) => {
      const varianten = p.attribute.reduce((n: number, a: Attribut) => n * a.werte.length, 1)
      const teile = p.attribute
        .map((a: Attribut) => `${a.name} (${a.werte.map((w) => w.name).join(', ')})`)
        .join(' × ')
      return (
        `${p.name}${p.verkaufspreis ? `, ${geld(p.verkaufspreis)}` : ''}` +
        (p.attribute.length > 0 ? ` — ${teile} ⇒ ${varianten} Varianten` : ' — ohne Varianten')
      )
    },
  },

  meldebestand_anlegen: {
    label: 'Meldebestand anlegen',
    bereich: 'lager',
    beschreibung:
      'Legt eine Nachbestellregel an: fällt der Bestand unter den Mindestbestand, schlägt die ' +
      'Beschaffung eine Bestellung oder Fertigung bis zum Maximalbestand vor.',
    schema: z
      .object({
        produkt: z.string().min(1),
        minimum: z.number().nonnegative(),
        maximum: z.number().nonnegative(),
        route: z.enum(['buy', 'manufacture']).optional(),
      })
      .refine((p) => p.maximum >= p.minimum, {
        message: 'Der Maximalbestand darf den Mindestbestand nicht unterschreiten',
        path: ['maximum'],
      }),
    zusammenfassung: (p) =>
      `${p.produkt}: unter ${p.minimum} auf ${p.maximum} auffüllen` +
      (p.route ? ` (${p.route === 'buy' ? 'bestellen' : 'fertigen'})` : ''),
  },

  arbeitsplatz_anlegen: {
    label: 'Arbeitsplatz anlegen',
    bereich: 'fertigung',
    beschreibung: 'Legt einen Arbeitsplatz mit Stundensatz an.',
    schema: z.object({
      kuerzel: z.string().min(1).max(20),
      name: z.string().min(1).max(80),
      stundensatz: z.number().nonnegative(),
      leistung: z.number().positive().max(500).optional().describe('in Prozent, Standard 100'),
    }),
    zusammenfassung: (p) => `${p.kuerzel} — ${p.name}, ${geld(p.stundensatz)} je Stunde`,
  },

  mitarbeiter_anlegen: {
    label: 'Mitarbeiter anlegen',
    bereich: 'personal',
    beschreibung: 'Legt einen Mitarbeiter mit Personalkostensatz an.',
    schema: z.object({
      name: z.string().min(1).max(120),
      funktion: z.string().max(80).optional(),
      abteilung: z.string().max(80).optional(),
      kostensatz: z.number().nonnegative().optional(),
      ausweis: z.string().max(40).optional(),
      wochenstunden: z.number().nonnegative().max(80).optional(),
    }),
    zusammenfassung: (p) =>
      `${p.name}${p.funktion ? ` — ${p.funktion}` : ''}` +
      (p.kostensatz ? `, ${geld(p.kostensatz)} je Stunde` : ''),
  },

  notiz_anlegen: {
    label: 'Notiz an einem Datensatz',
    bereich: 'ki',
    beschreibung:
      'Hängt eine Notiz an den Verlauf eines Datensatzes (model + record_id), z. B. an einen ' +
      'Verkaufsauftrag oder ein Produkt. Ändert keine Daten.',
    schema: z.object({
      model: z.enum([
        'sales_order',
        'purchase_order',
        'manufacturing_order',
        'stock_picking',
        'repair_order',
        'product_template',
        'partner',
        'employee',
      ]),
      record_id: z.string().regex(UUID_MUSTER, 'Bitte die ID des Datensatzes angeben'),
      text: z.string().min(1).max(1000),
    }),
    zusammenfassung: (p) => `Notiz an ${p.model}: „${p.text.slice(0, 120)}"`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  },
} satisfies Record<string, Aktion<any>>

export type AktionName = keyof typeof AKTIONEN

/** Werkzeugbeschreibung für das Modell — Katalog inklusive Kurzbeschreibung. */
export function aktionenTool() {
  const katalog = Object.entries(AKTIONEN)
    .map(([name, a]) => `- ${name} (${a.label}): ${a.beschreibung}`)
    .join('\n')

  return {
    name: 'aktion_vorschlagen',
    description:
      'Schlägt eine schreibende Aktion vor. Der Vorschlag wird dem Benutzer zur Bestätigung ' +
      'angezeigt und erst nach seinem Klick ausgeführt — du führst nichts selbst aus und ' +
      'behauptest auch nicht, etwas sei bereits angelegt. Schlage nur vor, was ausdrücklich ' +
      'gewünscht ist, und immer nur eine Aktion je Antwort. Verlässliche Bezeichner (SKU, ' +
      'Kundenname, IDs) vorher per sql_abfrage nachschlagen.\n\nVerfügbare Aktionen:\n' +
      katalog,
    input_schema: {
      type: 'object' as const,
      properties: {
        aktion: { type: 'string', enum: Object.keys(AKTIONEN) },
        parameter: {
          type: 'object',
          description: 'Die Felder der Aktion. Bei Fehlern nennt die Antwort die genaue Ursache.',
        },
        begruendung: {
          type: 'string',
          description: 'Ein Satz, warum das jetzt sinnvoll ist — steht mit im Bestätigungsdialog.',
        },
      },
      required: ['aktion', 'parameter'],
    },
  }
}

/** Prüft Namen und Felder. Wirft mit einer Meldung, die das Modell versteht. */
export function aktionPruefen(
  name: string,
  parameter: unknown,
): { name: AktionName; aktion: Aktion; werte: Record<string, unknown> } {
  const aktion = (AKTIONEN as Record<string, Aktion>)[name]
  if (!aktion) {
    throw new Error(`Unbekannte Aktion „${name}". Erlaubt: ${Object.keys(AKTIONEN).join(', ')}`)
  }
  const ergebnis = aktion.schema.safeParse(parameter)
  if (!ergebnis.success) {
    const meldungen = ergebnis.error.issues
      .map((i: z.ZodIssue) => `${i.path.join('.') || 'parameter'}: ${i.message}`)
      .join('; ')
    throw new Error(`Ungültige Felder für „${name}" — ${meldungen}`)
  }
  return { name: name as AktionName, aktion, werte: ergebnis.data as Record<string, unknown> }
}
