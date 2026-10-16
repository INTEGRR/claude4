import type { Sql, TransactionSql } from 'postgres'
import { type KiRegion, kiPfadBereit, kiRegionAufloesen } from './region.ts'

/**
 * KI-Ebene „Einkauf" (0109): Schalter, Monatsgrenze und Verbrauch.
 *
 * Der Agent läuft nur, wenn der Betreiber die Ebene eingeschaltet hat
 * (settings.ki_einkauf.aktiv, Standard aus), der KI-Weg der eingestellten
 * Region erreichbar ist (Standard: ANTHROPIC_API_KEY; EU: AWS-Zugang für
 * Bedrock; oder KI_FAKE=1) und die optionale Obergrenze in Token
 * je Kalendermonat nicht erreicht ist. Sonst überspringt er — erledigt,
 * nicht gescheitert, also keine Fehlerschleife in der Outbox.
 *
 * Bewusst app-frei (Sql injiziert, keine '@/'-Importe) — direkt testbar.
 */

type Db = Sql | TransactionSql

export const EINKAUF_KI_SCHLUESSEL = 'ki_einkauf'

export interface EinkaufKiStand {
  aktiv: boolean
  /** Obergrenze aller verarbeiteten Token je Kalendermonat (null = keine). */
  monats_tokens: number | null
}

export interface Verbrauch {
  aufrufe: number
  input: number
  output: number
  cache_lesen: number
  cache_schreiben: number
  /** Alle verarbeiteten Token — das zählt gegen die Monatsgrenze. */
  summe: number
}

/** Gespeicherten Wert lesen — Unbekanntes fällt auf „aus" zurück. */
export function einkaufKiStandLesen(wert: unknown): EinkaufKiStand {
  const w = (wert ?? {}) as Record<string, unknown>
  const grenze = Number(w.monats_tokens)
  return {
    aktiv: w.aktiv === true,
    monats_tokens: Number.isFinite(grenze) && grenze > 0 ? Math.floor(grenze) : null,
  }
}

export type Bereitschaft = { ok: true } | { ok: false; grund: string }

/**
 * Pure Entscheidung: darf der Agent jetzt laufen? Region-bewusst: geprüft
 * wird der Weg der eingestellten Region, nicht irgendein Schlüssel — sonst
 * würde ein fremder AWS-Zugang in der Umgebung den Lauf in eine
 * Fehlerschleife schicken, obwohl „Standard" gewählt ist.
 */
export function bereitschaft(
  stand: EinkaufKiStand,
  env: Record<string, string | undefined>,
  verbrauch: Pick<Verbrauch, 'summe'>,
  region: KiRegion = 'standard',
): Bereitschaft {
  if (!stand.aktiv) return { ok: false, grund: 'KI-Ebene „Einkauf" ist aus (Einstellungen → KI-Modelle)' }
  if (env.KI_FAKE !== '1' && !kiPfadBereit(region, env)) {
    return {
      ok: false,
      grund:
        region === 'eu'
          ? 'KI-Region „EU" gewählt, aber kein AWS-Zugang für Bedrock gesetzt (AWS_BEARER_TOKEN_BEDROCK oder Schlüsselpaar)'
          : 'ANTHROPIC_API_KEY ist nicht gesetzt',
    }
  }
  if (stand.monats_tokens !== null && verbrauch.summe >= stand.monats_tokens) {
    return {
      ok: false,
      grund: `Monatsgrenze von ${stand.monats_tokens.toLocaleString('de-DE')} Token erreicht (${verbrauch.summe.toLocaleString('de-DE')} verbraucht)`,
    }
  }
  return { ok: true }
}

export async function einkaufKiStand(db: Db): Promise<EinkaufKiStand> {
  const [zeile] = await db<{ value: unknown }[]>`select value from settings where key = ${EINKAUF_KI_SCHLUESSEL}`
  return einkaufKiStandLesen(zeile?.value)
}

/** Verbrauch einer KI-Ebene im laufenden Kalendermonat (Berliner Zeit). */
export async function verbrauchImMonat(db: Db, ebene: string): Promise<Verbrauch> {
  const [v] = await db<Omit<Verbrauch, 'summe'>[]>`
    select count(*)::int as aufrufe,
           coalesce(sum(input_tokens), 0)::float as input,
           coalesce(sum(output_tokens), 0)::float as output,
           coalesce(sum(cache_lesen_tokens), 0)::float as cache_lesen,
           coalesce(sum(cache_schreiben_tokens), 0)::float as cache_schreiben
    from ki_verbrauch
    where ebene = ${ebene}
      and created_at >= date_trunc('month', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'`
  const zeile = v ?? { aufrufe: 0, input: 0, output: 0, cache_lesen: 0, cache_schreiben: 0 }
  return { ...zeile, summe: zeile.input + zeile.output + zeile.cache_lesen + zeile.cache_schreiben }
}

/** Verbrauch je Ebene und Modell im laufenden Monat — für die Anzeige unter Einstellungen → KI. */
export async function verbrauchJeEbene(
  db: Db,
): Promise<{ ebene: string; modell: string; aufrufe: number; input: number; output: number; cache_lesen: number; cache_schreiben: number }[]> {
  return db`
    select ebene, modell, count(*)::int as aufrufe,
           coalesce(sum(input_tokens), 0)::float as input,
           coalesce(sum(output_tokens), 0)::float as output,
           coalesce(sum(cache_lesen_tokens), 0)::float as cache_lesen,
           coalesce(sum(cache_schreiben_tokens), 0)::float as cache_schreiben
    from ki_verbrauch
    where created_at >= date_trunc('month', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'
    group by ebene, modell
    order by ebene, modell`
}

export async function einkaufKiBereit(db: Db, env: Record<string, string | undefined> = process.env): Promise<Bereitschaft> {
  const stand = await einkaufKiStand(db)
  if (!stand.aktiv) return bereitschaft(stand, env, { summe: 0 })
  const [regionZeile] = await db<{ value: unknown }[]>`select value from settings where key = 'ki_region'`
  const region = kiRegionAufloesen(regionZeile?.value, env)
  return bereitschaft(stand, env, await verbrauchImMonat(db, 'einkauf'), region)
}
