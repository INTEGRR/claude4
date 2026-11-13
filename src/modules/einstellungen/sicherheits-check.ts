/**
 * Täglicher Sicherheits-Check (Entscheidungslog 2026-11-13): prüft morgens,
 * ob etwas Aufmerksamkeit braucht, und meldet NUR dann per Telegram —
 * bekannte Lücken in Abhängigkeiten (ab „hoch"), Konten ohne zweiten Faktor,
 * das Startkonto, auffällig viele Fehlanmeldungen oder Fehlsuchen im
 * Retourenportal, fehlende Betriebs-Geheimnisse. Gestörte Dienste meldet
 * weiter der Dienste-Wächter, kaputte Buchungen der Daten-TÜV.
 *
 * Pur (Stand und fetch als Parameter), damit unter blankem Node testbar;
 * das Einsammeln und Einreihen macht sicherheits-lauf.ts.
 */
import { telegramSicher } from '../integrationen/telegram.ts'

/** Ab so vielen Fehlanmeldungen in 24 Stunden gilt es als auffällig. */
export const FEHLANMELDUNGEN_AUFFAELLIG = 30
/** Ab so vielen gezählten Fehlsuchen im Retourenportal in 24 Stunden. */
export const PORTAL_FEHLSUCHEN_AUFFAELLIG = 60

const ADVISORY_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

export interface Luecke {
  paket: string
  versionen: string[]
  schwere: 'critical' | 'high'
  titel: string
  /** Bereich der betroffenen Versionen, z. B. „<4.6.6". */
  betroffen: string
  url: string
}

export interface SicherheitsStand {
  luecken: Luecke[]
  adminsOhne2fa: number
  startkontoAktiv: boolean
  fehlanmeldungen24h: number
  portalFehlsuchen24h: number
  /** Namen der Pflicht-Variablen, die nicht gesetzt sind (CRON_SECRET, SESSION_SECRET). */
  fehlendeGeheimnisse: string[]
}

/** Paketname → installierte Versionen, aus einer package-lock.json (lockfileVersion 2/3). */
export function paketeAusLockfile(lock: { packages?: Record<string, { version?: string }> }): Record<string, string[]> {
  const pakete: Record<string, Set<string>> = {}
  for (const [pfad, eintrag] of Object.entries(lock.packages ?? {})) {
    // '' ist das Projekt selbst; verschachtelte Pfade tragen den Namen hinter dem letzten node_modules/.
    const name = pfad.split('node_modules/').pop()
    if (!pfad || !name || !eintrag.version) continue
    ;(pakete[name] ??= new Set()).add(eintrag.version)
  }
  return Object.fromEntries(Object.entries(pakete).map(([name, v]) => [name, [...v].sort()]))
}

/**
 * Fragt die Advisory-Datenbank der npm-Registry für genau die installierten
 * Versionen (dieselbe Quelle wie `npm audit`). Geliefert werden nur Lücken ab
 * „hoch". Wirft bei Netz- oder Antwortfehler — der Job versucht es dann
 * erneut, statt „keine Lücken" zu melden.
 */
export async function lueckenAbrufen(
  pakete: Record<string, string[]>,
  abruf: typeof fetch = fetch,
): Promise<Luecke[]> {
  const antwort = await abruf(ADVISORY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pakete),
    signal: AbortSignal.timeout(20_000),
  })
  if (!antwort.ok) throw new Error(`Advisory-Abfrage fehlgeschlagen: HTTP ${antwort.status}`)
  const daten = (await antwort.json()) as Record<
    string,
    { severity?: string; title?: string; vulnerable_versions?: string; url?: string }[]
  >
  const luecken: Luecke[] = []
  for (const [paket, eintraege] of Object.entries(daten)) {
    for (const e of eintraege ?? []) {
      if (e.severity !== 'high' && e.severity !== 'critical') continue
      luecken.push({
        paket,
        versionen: pakete[paket] ?? [],
        schwere: e.severity,
        titel: e.title ?? 'ohne Titel',
        betroffen: e.vulnerable_versions ?? '',
        url: e.url ?? '',
      })
    }
  }
  return luecken.sort((a, b) => a.schwere.localeCompare(b.schwere) || a.paket.localeCompare(b.paket))
}

/** Was heute Aufmerksamkeit braucht — leer heißt: keine Nachricht. */
export function sicherheitsBefunde(s: SicherheitsStand): string[] {
  const befunde: string[] = []
  for (const l of s.luecken) {
    befunde.push(
      `Abhängigkeit ${l.paket} ${l.versionen.join(', ')}: ${l.schwere === 'critical' ? 'kritisch' : 'hoch'} — ` +
        `${l.titel}${l.betroffen ? ` (betroffen ${l.betroffen})` : ''}`,
    )
  }
  if (s.fehlendeGeheimnisse.length > 0) befunde.push(`Betriebs-Geheimnis fehlt: ${s.fehlendeGeheimnisse.join(', ')}`)
  if (s.startkontoAktiv) befunde.push('Startkonto admin@example.com ist noch aktiv')
  if (s.adminsOhne2fa > 0) {
    befunde.push(s.adminsOhne2fa === 1 ? 'Ein Admin hat keinen zweiten Faktor' : `${s.adminsOhne2fa} Admins haben keinen zweiten Faktor`)
  }
  if (s.fehlanmeldungen24h >= FEHLANMELDUNGEN_AUFFAELLIG) {
    befunde.push(`${s.fehlanmeldungen24h} Fehlanmeldungen in den letzten 24 Stunden`)
  }
  if (s.portalFehlsuchen24h >= PORTAL_FEHLSUCHEN_AUFFAELLIG) {
    befunde.push(`${s.portalFehlsuchen24h} Fehlsuchen im Retourenportal in den letzten 24 Stunden`)
  }
  return befunde
}

/** Telegram-Text (HTML-Parse-Modus) — null, wenn es nichts zu melden gibt. */
export function sicherheitsText(befunde: string[], p: { datum: string; basisUrl?: string | null }): string | null {
  if (befunde.length === 0) return null
  const [jahr, monat, tag] = p.datum.split('-')
  const kopf = `🛡️ <b>Sicherheits-Check ${tag}.${monat}.${jahr}</b> — ${befunde.length === 1 ? '1 Punkt' : `${befunde.length} Punkte`}`
  const zeilen = befunde.slice(0, 12).map((b) => `• ${telegramSicher(b.slice(0, 300))}`)
  if (befunde.length > 12) zeilen.push(`… und ${befunde.length - 12} weitere`)
  const fuss = p.basisUrl ? `\n${p.basisUrl}/einstellungen/produktivgang` : ''
  return `${kopf}\n${zeilen.join('\n')}${fuss}`
}
