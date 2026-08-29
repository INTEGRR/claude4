import { z } from 'zod'
import type { Area, Role } from '../../auth/permissions.ts'

/**
 * Die Aktions-Registry — das Typenfundament des prozessorientierten Umbaus.
 *
 * Jeder Knopf im ERP wird eine hier registrierte Aktion: benannt, mit
 * geprüftem Eingabeschema, ausgewiesenem Berechtigungsbereich und (für
 * beleggebundene Aktionen) dem erwarteten Statusübergang. Damit sind Knöpfe
 * keine UI-Eigenheiten mehr, sondern adressierbare API-Aufrufe — der
 * Prozesstest drückt keine Knöpfe, er ruft Aktionen.
 *
 * Diese Datei und die Katalogdateien (registry/<modul>.ts) bleiben bewusst
 * frei von Datenbank- und Server-Importen (nur Typ-Importe): der Katalog muss
 * unter blankem Node testbar sein, genau wie der KI-Aktionskatalog, dessen
 * Muster hier generalisiert wird. Die Ausführung lebt getrennt in
 * <modul>-ausfuehren.ts; `AUSFUEHRUNG satisfies Record<AktionsName, …>`
 * erzwingt zur Compile-Zeit, dass keine Aktion ohne Ausführung bleibt.
 */

export interface RegistrierteAktion<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Knopfbeschriftung — adressierbar statt nur JSX-Text. */
  label: string
  bereich: Area
  beschreibung: string
  /** Eingabefelder (ohne die Beleg-ID — die kommt als recordId). */
  schema: S
  /** Menschenlesbare Zusammenfassung, z. B. für Bestätigungen und das Audit. */
  zusammenfassung?: (p: z.infer<S>) => string

  // --- Prozess-Metadaten ---------------------------------------------------
  /** Betroffenes Belegmodell (z. B. 'stock_picking') — Schlüssel der Statusmaschine. */
  modell?: string
  /** 'beleg' = braucht eine recordId; 'frei' = belegunabhängig (Anlage, Stammdaten). */
  bindung: 'beleg' | 'frei'
  /**
   * Erwarteter Statusübergang. Der Prozesstest prüft ihn nach jedem Schritt —
   * `nach` ist eine Menge, weil manche Übergänge zwei legitime Ziele haben
   * (picking_confirm endet je nach Bestand in confirmed ODER assigned).
   */
  uebergang?: { von: string[]; nach: string[] }
  /** Ausdrücklich keinem Prozess zugeordnet — der Vollständigkeitstest verlangt sonst einen Schritt. */
  prozessfrei?: true
  /** Verwaltungsaktion: nur Administratoren (statt canWrite auf den Bereich). */
  nurAdmin?: true
  /**
   * Der KI-Agent darf diese Aktion VORSCHLAGEN (ausgeführt wird weiterhin
   * erst nach Bestätigung im Chat, über den Torwächter). IDs schlägt der
   * Agent vorher per sql_abfrage nach.
   */
  ki?: true

  // --- Brücken zum Altbestand und zur Oberfläche ---------------------------
  /**
   * Übersetzt das FormData der bestehenden Formulare in die Schema-Parameter.
   * Muss rein bleiben (kein Datenbankzugriff) — fachliche Auflösung gehört in
   * die Ausführung. Generierte Masken schicken direkt JSON und brauchen das nicht.
   */
  formdata?: (fd: FormData) => unknown
  /**
   * Pfade, die nach Erfolg neu geladen werden. Platzhalter: ':id' = die
   * Beleg-ID des Aufrufs, ':ergebnis' = die vom Ergebnis gelieferte recordId
   * (z. B. der neu entstandene Retoure-Transfer).
   */
  revalidate?: string[]
}

export interface AktionsKontext {
  actor: string
  role: Role
  recordId?: string
  /** Benutzer-ID des Ausführenden — für Aktionen, die den Datensatz zuweisen. */
  userId?: string
}

/**
 * Ergebnis einer Ausführung. `recordId` benennt den entstandenen/betroffenen
 * Datensatz — Prozessschritte reichen ihn aneinander weiter, die Oberfläche
 * baut daraus Links.
 */
export interface AktionsErgebnis {
  text?: string
  link?: string
  recordId?: string
}

export type AktionsFn<S extends z.ZodTypeAny = z.ZodTypeAny> = (
  p: z.infer<S>,
  ctx: AktionsKontext,
) => Promise<AktionsErgebnis | void>

export const UUID_MUSTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Deutsche Geldschreibweise für Zusammenfassungen — bewusst ohne Intl (DB-frei, deterministisch). */
export const geld = (v: number) => v.toFixed(2).replace('.', ',') + ' €'

/**
 * Eine Belegzeile der Kombi-Aktionen (Auftrag/Bestellung mit Positionen) —
 * gemeinsam, damit Verkauf und Einkauf dieselbe Zeilensprache sprechen.
 */
export const positionenSchema = z.object({
  produkt: z.string().min(1).describe('SKU, Barcode, Name oder ID der Variante'),
  menge: z.number().positive(),
  preis: z.number().nonnegative().optional().describe('Netto je Einheit; leer = Preisfindung'),
})
export type PositionsZeile = z.infer<typeof positionenSchema>
