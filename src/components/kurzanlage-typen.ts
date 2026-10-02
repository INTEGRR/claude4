import type { ActionResult } from '@/modules/shared/action'

/**
 * Kurzanlage in der Auswahlbox (Betreiber 2026-10-02: „man muss auch hier
 * neue anlegen können, ad hoc — generell für alle Themen, die so etwas
 * erfordern"). Die Seite gibt der Box mit, WAS sie anlegen darf; die Box
 * zeigt das Mini-Formular und wählt den neuen Eintrag sofort aus.
 *
 * Bewusst nur Daten plus eine Server Action — so reist die Beschreibung
 * vom Server Component zur Client-Komponente.
 */

export interface KurzFeld {
  name: string
  label: string
  /** text (Standard), email, oder wahl = Knopfreihe aus `optionen`. */
  art?: 'text' | 'email' | 'wahl'
  pflicht?: boolean
  platzhalter?: string
  optionen?: { wert: string; text: string }[]
  vorgabe?: string
}

export interface Kurzanlage {
  /** z. B. „Neuer Lieferant" — steht über dem Mini-Formular. */
  titel: string
  /** Wort im Angebot „„Suchtext" als … anlegen", z. B. „Lieferant". */
  was: string
  /** Das erste Textfeld bekommt den Suchtext. */
  felder: KurzFeld[]
  /**
   * Legt an (über die Registry) und liefert bei Erfolg
   * `daten: { id, text }` — die neue Option, wie sie in der Liste stünde.
   */
  aktion: (werte: Record<string, string>) => Promise<ActionResult>
}
