/**
 * TLS zur Datenbank (Entscheidungslog 2026-10-01, „Datenbank-TLS im Code").
 *
 * Entfernte Datenbanken (Supabase: Pooler wie Direktverbindung) laufen immer
 * verschlüsselt — so lässt sich „Enforce SSL" in Supabase einschalten, ohne
 * die DATABASE_URL anzufassen. Lokal und im Docker-Betrieb (localhost,
 * 127.0.0.1, ::1, Dienstname ohne Punkt wie `db`) ohne TLS.
 *
 * Wer es anders braucht, sagt es ausdrücklich: ein `sslmode`/`ssl` in der URL
 * oder PGSSL/PGSSLMODE in der Umgebung hat Vorrang (z. B. `verify-full` mit
 * eigenem Zertifikat, `disable` für einen Sonderfall).
 *
 * Rein rechnend, ohne Importe: auch die Wartungsskripte (Migration, Seed im
 * Vercel-Build) nutzen es unter blankem Node.
 */
type SslModus = 'require' | 'prefer' | 'allow' | 'verify-full' | false

export function datenbankSsl(url: string): { ssl?: SslModus } {
  // PGSSL liest postgres.js selbst, PGSSLMODE (libpq-Name) nicht — hier übersetzt.
  if (process.env.PGSSL) return {}
  const modus = process.env.PGSSLMODE
  if (modus) return { ssl: modus === 'disable' ? false : (modus as SslModus) }
  let host: string
  try {
    const u = new URL(url)
    if (u.searchParams.has('sslmode') || u.searchParams.has('ssl')) return {}
    host = u.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return {}
  }
  const lokal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.')
  return { ssl: lokal ? false : 'require' }
}
