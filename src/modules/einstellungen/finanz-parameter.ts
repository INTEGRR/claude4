/**
 * Die Stellschrauben der Cashflow-Prognose (settings-Schlüssel 'finanzen').
 * Gemeinsame Quelle für die Einstellungsseite (Formularfelder) und den
 * Registry-Katalog (Schema der Aktion einstellungen.finanz_parameter_setzen)
 * — pur, damit der Katalog unter blankem Node ladbar bleibt.
 *
 * Gespeichert wird per Merge: Schlüssel, die hier NICHT stehen (z. B.
 * vertrag_kategorien), bleiben unangetastet.
 */

export interface FinanzFeld {
  name: string
  label: string
  min?: number
  max?: number
}

export const FINANZ_FELDER: readonly FinanzFeld[] = [
  { name: 'wareneinsatz_pct', label: 'Wareneinsatz (% vom Planumsatz)', min: 0, max: 100 },
  { name: 'versand_pct', label: 'Versand (%)', min: 0, max: 100 },
  { name: 'fees_pct', label: 'Gebühren/Fees (%)', min: 0, max: 100 },
  { name: 'ust_satz_pct', label: 'USt-Satz (%)', min: 0, max: 100 },
  { name: 'ust_zahllast_quote_pct', label: 'USt-Zahllast-Quote (% vom Planumsatz)', min: 0, max: 100 },
  { name: 'ust_zahltag', label: 'USt-Zahltag (1–28)', min: 1, max: 28 },
  { name: 'ust_frist_monate', label: 'USt-Frist (Monate)', min: 0, max: 6 },
  { name: 'shopify_versatz_tage', label: 'Shopify-Auszahlung (Tage)', min: 0, max: 60 },
  { name: 'rechnung_versatz_tage', label: 'Zahlungsziel Rechnung (Tage)', min: 0, max: 120 },
  { name: 'best_aufschlag_pct', label: 'Best-Szenario: Aufschlag (%)', min: 0, max: 100 },
  { name: 'worst_abschlag_pct', label: 'Worst-Szenario: Abschlag (%)', min: 0, max: 100 },
  { name: 'liquiditaets_puffer', label: 'Liquiditätspuffer (€)', min: 0 },
  { name: 'transit_tage', label: 'Transitzeit See (Tage)', min: 0, max: 120 },
  { name: 'kuendigungs_vorlauf_tage', label: 'Kündigungs-Vorlauf (Tage)', min: 0, max: 365 },
]

/** Formularwert → Zahl; Komma als Dezimaltrenner erlaubt, leer = NaN (vom Schema abgewiesen). */
export function zahlAusFormular(roh: FormDataEntryValue | null): number {
  const text = String(roh ?? '').trim().replace(',', '.')
  return text === '' ? Number.NaN : Number(text)
}

/** Optionale Zahl aus dem Formular: leer = nicht angegeben (undefined), sonst wie zahlAusFormular. */
export function optionaleZahl(roh: FormDataEntryValue | null): number | undefined {
  return String(roh ?? '').trim() === '' ? undefined : zahlAusFormular(roh)
}

/** Labelformate der DHL-Etiketten — Seite und Katalog teilen die Liste. */
export const DRUCKFORMATE = [
  { wert: '910-300-700', label: '910-300-700 (105 × 208 mm)' },
  { wert: '910-300-600', label: '910-300-600 (Thermo 103 × 199)' },
  { wert: '910-300-400', label: '910-300-400 (Thermo 103 × 150)' },
  { wert: 'A4', label: 'A4' },
] as const
