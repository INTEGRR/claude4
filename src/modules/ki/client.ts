import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import type { Sql, TransactionSql } from 'postgres'
import { sql } from '@/db/client'
import { type KiEbene, kiModell } from './modelle.ts'
import {
  type KiRegion,
  bedrockModellId,
  bedrockRegion,
  kiPfadBereit,
  kiRegionAufloesen,
  openaiBasis,
} from './region.ts'

/**
 * Eine Fabrik für alle Claude-Aufrufe (Entscheidungslog 2026-10-16): liest
 * die Region aus den Einstellungen und liefert den passenden Client samt
 * aufgelöstem Modell — Anthropic-API direkt (Standard) oder Amazon Bedrock
 * mit EU-Inferenzprofil. Die Aufrufstellen kennen nur `client.messages`;
 * beide SDKs sprechen dieselbe Messages-API (Tools, Streaming, Caching,
 * Bild- und Dokumentblöcke).
 *
 * Kein stiller Rückfall: fehlt der Zugang für die gewählte Region, wirft die
 * Fabrik mit Hinweis auf Einstellungen → KI-Modelle.
 */

export type KiClient = Pick<Anthropic, 'messages'>

export interface ClientOptionen {
  timeout?: number
  maxRetries?: number
}

export async function kiRegion(db: Sql | TransactionSql = sql): Promise<KiRegion> {
  const [zeile] = await db<{ value: unknown }[]>`select value from settings where key = 'ki_region'`
  return kiRegionAufloesen(zeile?.value)
}

export function kiZugangFehlt(region: KiRegion): string {
  return region === 'eu'
    ? 'KI-Region „EU" gewählt, aber kein AWS-Zugang für Bedrock hinterlegt (AWS_BEARER_TOKEN_BEDROCK oder ' +
        'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY). Zugang setzen oder unter Einstellungen → KI-Modelle auf „Standard" stellen.'
    : 'KI nicht konfiguriert — ANTHROPIC_API_KEY fehlt.'
}

function clientBauen(region: KiRegion, optionen: ClientOptionen): KiClient {
  if (!kiPfadBereit(region)) throw new Error(kiZugangFehlt(region))
  if (region === 'eu') {
    // Der Bedrock-Client bringt seine eigene SDK-Fassung mit; das
    // Messages-Interface ist dasselbe, deshalb die strukturelle Angleichung.
    return new AnthropicBedrock({ awsRegion: bedrockRegion(), ...optionen }) as unknown as KiClient
  }
  return new Anthropic(optionen)
}

/** Client für die eingestellte Region. */
export async function kiClient(
  db: Sql | TransactionSql = sql,
  optionen: ClientOptionen = {},
): Promise<{ client: KiClient; region: KiRegion }> {
  const region = await kiRegion(db)
  return { client: clientBauen(region, optionen), region }
}

/** Client plus Modell der Ebene — in der EU als Bedrock-Inferenzprofil. */
export async function kiClientMitModell(
  db: Sql | TransactionSql,
  ebene: KiEbene,
  optionen: ClientOptionen = {},
): Promise<{ client: KiClient; modell: string; region: KiRegion }> {
  const region = await kiRegion(db)
  const katalog = await kiModell(db, ebene)
  return {
    client: clientBauen(region, optionen),
    modell: region === 'eu' ? bedrockModellId(katalog) : katalog,
    region,
  }
}

/**
 * HTTP-Status eines SDK-Fehlers, SDK-Kopie-unabhängig: der Bedrock-Client
 * bringt eine eigene `@anthropic-ai/sdk`-Fassung mit, deren APIError nicht
 * `instanceof` der Wurzelklasse ist.
 */
export function apiStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/** Basis-URL der OpenAI-API nach Region (Transkription, Ansage, Realtime). */
export async function openaiBasisUrl(db: Sql | TransactionSql = sql): Promise<string> {
  return openaiBasis(await kiRegion(db))
}

/**
 * Verbindungsprobe für den Dienste-Wächter: Standard listet Modelle, Bedrock
 * kennt keine Modellliste — dort eine Ein-Token-Nachricht an das günstigste
 * Katalogmodell (beweist Zugang, Region UND Profil-ID).
 */
export async function kiVerbindungPruefen(zeitlimitMs: number): Promise<void> {
  const region = await kiRegion()
  if (region === 'eu') {
    const client = clientBauen(region, { timeout: zeitlimitMs, maxRetries: 0 })
    await client.messages.create({
      model: bedrockModellId('claude-haiku-4-5-20251001'),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    return
  }
  if (!kiPfadBereit(region)) throw new Error(kiZugangFehlt(region))
  await new Anthropic({ timeout: zeitlimitMs, maxRetries: 0 }).models.list({ limit: 1 })
}
