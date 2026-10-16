import { MODELL_KATALOG, type ModellId } from './modelle.ts'

/**
 * Region der KI-Verarbeitung — eine Betreiber-Einstellung (settings-Schlüssel
 * `ki_region`, Registry-Aktion `einstellungen.ki_region_setzen`), kein
 * Env-Geheimnis. Zwei Wege, derselbe Code dahinter:
 *
 *   standard  Claude über die Anthropic-API (ANTHROPIC_API_KEY), OpenAI über
 *             api.openai.com — der bisherige Weg und die Vorgabe.
 *   eu        Claude über Amazon Bedrock mit EU-Inferenzprofil (`eu.`-Präfix,
 *             Verarbeitung in EU-Regionen, AWS-Zugang nötig), OpenAI über den
 *             EU-Endpunkt eu.api.openai.com (Speicherung und Verarbeitung in
 *             EWR + Schweiz; setzt beim OpenAI-Projekt Zero Data Retention
 *             oder Modified Abuse Monitoring voraus).
 *
 * Bewusst KEIN stiller Rückfall von „eu" auf „standard": wer die EU wählt und
 * keinen AWS-Zugang hinterlegt, bekommt einen klaren Fehler — Daten wandern
 * nicht unbemerkt in eine andere Region. Zurückschalten ist ein Klick.
 * Bewusst app-frei (kein server-only, env injiziert) — direkt testbar.
 */

export const KI_REGIONEN = [
  {
    id: 'standard',
    label: 'Standard',
    hinweis: 'Anthropic-API direkt und OpenAI global — der bisherige Weg',
  },
  {
    id: 'eu',
    label: 'EU',
    hinweis: 'Claude über Amazon Bedrock in der EU, OpenAI über den EU-Endpunkt (ZDR/MAM beim OpenAI-Projekt nötig)',
  },
] as const

export type KiRegion = (typeof KI_REGIONEN)[number]['id']

export function istKiRegion(wert: unknown): wert is KiRegion {
  return KI_REGIONEN.some((r) => r.id === wert)
}

/** Einstellung → Env-Notausgang `KI_REGION` → Standard. */
export function kiRegionAufloesen(
  gespeichert: unknown,
  env: Record<string, string | undefined> = process.env,
): KiRegion {
  const wert = (gespeichert as Record<string, unknown> | null | undefined)?.region
  if (istKiRegion(wert)) return wert
  if (istKiRegion(env.KI_REGION)) return env.KI_REGION
  return 'standard'
}

/** Basis-URL der OpenAI-API je Region (Transkription, Sprachausgabe, Realtime-Secrets und WebRTC-Aufbau). */
export function openaiBasis(region: KiRegion): string {
  return region === 'eu' ? 'https://eu.api.openai.com' : 'https://api.openai.com'
}

/**
 * Modell-IDs auf Bedrock je Katalogmodell (ohne Geo-Präfix). Ab der
 * 4.6-Generation sind die IDs datumslos; Haiku 4.5 trägt noch das Datum.
 * Das Geo-Präfix (`eu.`) macht daraus das Inferenzprofil mit garantierter
 * Verarbeitung in der Region. Prüfbar mit
 * `aws bedrock list-inference-profiles --region <Region>`; weicht ein Profil
 * ab, übersteuert BEDROCK_MODELL_<KATALOG-ID in Großbuchstaben, - → _>.
 */
export const BEDROCK_IDS: Record<ModellId, string> = {
  'claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'claude-opus-5': 'anthropic.claude-opus-5',
  'claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'claude-haiku-4-5-20251001': 'anthropic.claude-haiku-4-5-20251001-v1:0',
}

export function bedrockPraefix(env: Record<string, string | undefined> = process.env): string {
  return env.BEDROCK_PRAEFIX ?? 'eu.'
}

/** Katalog- oder Env-Modell → Bedrock-Inferenzprofil der Region. */
export function bedrockModellId(
  modell: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const uebersteuert = env[`BEDROCK_MODELL_${modell.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
  if (uebersteuert) return uebersteuert
  // Bereits ein Bedrock-Profil (z. B. aus einer Env-Variable): unverändert.
  if (/^[a-z]+\.anthropic\.|^anthropic\./.test(modell)) return modell
  const basis = (BEDROCK_IDS as Record<string, string>)[modell] ?? `anthropic.${modell}`
  return `${bedrockPraefix(env)}${basis}`
}

/** AWS-Region für Bedrock: BEDROCK_REGION vor AWS_REGION, sonst Irland (EU-Inferenz in-region). */
export function bedrockRegion(env: Record<string, string | undefined> = process.env): string {
  return env.BEDROCK_REGION ?? env.AWS_REGION ?? 'eu-west-1'
}

/** AWS-Zugang vorhanden: Bedrock-API-Key (Bearer) oder klassisches Schlüsselpaar. */
export function bedrockBereit(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AWS_BEARER_TOKEN_BEDROCK) || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
}

/** Ist der Claude-Weg der Region einsatzbereit? */
export function kiPfadBereit(region: KiRegion, env: Record<string, string | undefined> = process.env): boolean {
  return region === 'eu' ? bedrockBereit(env) : Boolean(env.ANTHROPIC_API_KEY)
}

/**
 * Irgendein Claude-Weg konfiguriert (Schlüssel ODER AWS-Zugang)? Die
 * synchrone Prüfung der Seiten und Routen; welcher Weg gilt, entscheidet die
 * Einstellung — passt beides nicht zusammen, meldet es der Dienste-Wächter
 * und die Seite Einstellungen → KI-Modelle.
 */
export function kiKonfiguriert(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) || bedrockBereit(env)
}

/** Kennt der Katalog das Modell (für die Anzeige der aufgelösten Bedrock-IDs)? */
export function katalogModelle(): readonly ModellId[] {
  return MODELL_KATALOG.map((m) => m.id)
}
