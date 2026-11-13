import 'server-only'
import { sql } from '@/db/client'
import { einreihen } from '@/modules/integrationen/benachrichtigungen'
import { plural } from '@/modules/shared/format'
import {
  type SicherheitsStand,
  lueckenAbrufen,
  paketeAusLockfile,
  sicherheitsBefunde,
  sicherheitsText,
} from './sicherheits-check.ts'
import { ANBINDUNGEN, anbindungsStand } from './umgebung.ts'

/**
 * Job sicherheits_check: sammelt den Stand ein und reiht bei Befunden eine
 * Telegram-Nachricht der Art 'sicherheit' ein (Schlüssel je Tag — solange ein
 * Punkt offen ist, kommt die Erinnerung jeden Morgen einmal). Ohne Befund
 * keine Nachricht. Die Lockfile reist im Bundle mit; geprüft wird also genau
 * die ausgelieferte Fassung gegen den heutigen Stand der Advisory-Datenbank.
 */
export async function sicherheitsCheckEinreihen(datum = new Date().toISOString().slice(0, 10)): Promise<string> {
  const lock = (await import('../../../package-lock.json')).default as { packages?: Record<string, { version?: string }> }
  const pakete = paketeAusLockfile(lock)

  const [luecken, [konten], [versuche]] = await Promise.all([
    lueckenAbrufen(pakete),
    sql<{ ohne2fa: number; startkonto: boolean | null }[]>`
      select count(*) filter (where role = 'admin' and totp_aktiviert_at is null)::int as ohne2fa,
             bool_or(lower(email) = 'admin@example.com') as startkonto
      from users where active`,
    sql<{ logins: number; portal: number }[]>`
      select (select count(*)::int from login_versuche where created_at > now() - interval '24 hours') as logins,
             (select count(*)::int from portal_suchversuche where created_at > now() - interval '24 hours') as portal`,
  ])
  const system = anbindungsStand(ANBINDUNGEN.find((a) => a.schluessel === 'system')!, process.env)

  const stand: SicherheitsStand = {
    luecken,
    adminsOhne2fa: konten.ohne2fa,
    startkontoAktiv: Boolean(konten.startkonto),
    fehlanmeldungen24h: versuche.logins,
    portalFehlsuchen24h: versuche.portal,
    fehlendeGeheimnisse: system.fehlend,
  }
  const befunde = sicherheitsBefunde(stand)
  const basisUrl =
    process.env.ERP_PUBLIC_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  const text = sicherheitsText(befunde, { datum, basisUrl })
  const geprueft = `${plural(Object.keys(pakete).length, 'Paket', 'Pakete')} geprüft`
  if (!text) return `Keine Befunde — keine Nachricht (${geprueft})`
  const id = await einreihen(sql, 'sicherheit', `sicherheit:${datum}`, text)
  return id
    ? `${plural(befunde.length, 'Befund', 'Befunde')} an Telegram eingereiht (${geprueft})`
    : `${plural(befunde.length, 'Befund', 'Befunde')} — für heute schon gemeldet`
}
