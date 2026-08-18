import 'server-only'

/**
 * Datenfrage-Fallback des Sprachmodus (Ausbaustufe 3): eine kurze, nicht
 * streamende Modellrunde mit Schema-Doku + Read-only-SQL beantwortet
 * komplexe Fragen. Bis zur Ausbaustufe 3 ist das Werkzeug nicht im
 * Sprachkatalog — dieser Platzhalter hält den Dispatcher vollständig.
 */
export async function datenfrageBeantworten(_frage: string, _actor: string): Promise<string> {
  return 'Datenfragen sind in dieser Ausbaustufe noch nicht verfügbar.'
}
