import type { Sql, TransactionSql } from 'postgres'

/**
 * Modellwahl je KI-Ebene — eine Betreiber-Einstellung, kein Env-Geheimnis.
 *
 * KRNL hat mehrere KI-Ebenen mit sehr unterschiedlichem Anspruchsniveau:
 * die Auswertung braucht sauberes SQL über echten Daten, die schnelle
 * Datenfrage im Sprachmodus vor allem Tempo. Welche Ebene welches Modell
 * nutzt, entscheidet der Betreiber unter Einstellungen (settings-Schlüssel
 * `ki_modelle`, gesetzt über die Registry-Aktion
 * `einstellungen.ki_modelle_setzen`). Umgebungsvariablen bleiben als
 * Notausgang für den Betrieb (Reihenfolge: Einstellung → Env → Standard).
 * Bewusst app-frei (kein server-only, Sql injiziert) — direkt testbar.
 */

export const MODELL_KATALOG = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    hinweis: 'höchste Qualität, höchster Preis — für Prozess-Entwurf und knifflige Analysen',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    hinweis: 'starke Alltagsklasse zu deutlich geringerem Preis — für die meisten Auswertungen',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    hinweis: 'schnell und günstig — für kurze Fragen und den Sprachmodus',
  },
] as const

export type ModellId = (typeof MODELL_KATALOG)[number]['id']

export const KI_EBENEN = [
  {
    key: 'auswertung',
    label: 'Auswertungen & SQL-Fragen',
    hinweis: 'der Chat-Agent unter /ki inklusive Vorschlag-Überarbeitung',
    standard: 'claude-opus-5',
    env: ['ANTHROPIC_MODEL'],
  },
  {
    key: 'prozess',
    label: 'Prozess-Aufnahme & -Entwurf',
    hinweis: 'Interviews strukturieren, Prozesse entwerfen und ändern',
    standard: 'claude-opus-5',
    env: ['AUFNAHME_MODELL', 'ANTHROPIC_MODEL'],
  },
  {
    key: 'interview',
    label: 'Onboarding-Interview',
    hinweis: 'die Fragerunden der geführten Einrichtung',
    standard: 'claude-opus-5',
    env: ['AUFNAHME_MODELL', 'ANTHROPIC_MODEL'],
  },
  {
    key: 'datenfrage',
    label: 'Schnelle Datenfrage (Sprechen)',
    hinweis: 'kurze Antworten für die Sprachausgabe',
    standard: 'claude-haiku-4-5-20251001',
    env: ['DATENFRAGE_MODELL'],
  },
] as const

export type KiEbene = (typeof KI_EBENEN)[number]['key']

export function istKatalogModell(wert: unknown): wert is ModellId {
  return MODELL_KATALOG.some((m) => m.id === wert)
}

/**
 * Pure Auflösung: gespeicherter Einstellungswert (nur Katalog-Modelle
 * zählen — ein Tippfehler in der DB fällt still auf den nächsten Anker
 * zurück statt die KI zu brechen) → Env-Notausgang → Standard der Ebene.
 */
export function modellAufloesen(
  gespeichert: unknown,
  ebene: KiEbene,
  env: Record<string, string | undefined> = process.env,
): string {
  const eintrag = KI_EBENEN.find((e) => e.key === ebene)
  if (!eintrag) throw new Error(`Unbekannte KI-Ebene „${ebene}"`)
  const wert = (gespeichert as Record<string, unknown> | null | undefined)?.[ebene]
  if (istKatalogModell(wert)) return wert
  for (const variable of eintrag.env) {
    const ausEnv = env[variable]
    if (ausEnv) return ausEnv
  }
  return eintrag.standard
}

/** Liest die Einstellung und löst das Modell für eine Ebene auf. */
export async function kiModell(client: Sql | TransactionSql, ebene: KiEbene): Promise<string> {
  const [zeile] = await client<
    { value: unknown }[]
  >`select value from settings where key = 'ki_modelle'`
  return modellAufloesen(zeile?.value, ebene)
}
