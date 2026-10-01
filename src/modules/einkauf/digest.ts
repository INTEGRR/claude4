import { sql } from '@/db/client'
import { einreihen } from '@/modules/integrationen/benachrichtigungen'
import { cockpitLaden, digestText } from './cockpit.ts'

/**
 * Job einkauf_digest (0108): die tägliche Zusammenfassung des Einkaufs-
 * Cockpits in den bestehenden Telegram-Kanal, gegliedert nach Einkäufer.
 * Eingereiht als Benachrichtigung der Art 'einkauf' mit Schlüssel je Tag —
 * ein zweiter Lauf am selben Tag erneuert nur den noch nicht gesendeten
 * Text, nach dem Versand blockiert der Schlüssel. Gesendet wird vom Cron
 * „jobs"; abschalten lässt sie sich unter Einstellungen →
 * Benachrichtigungen. Der Kanal gehört dem Betreiber — deshalb mit den
 * fälligen Raten.
 */
export async function einkaufDigestEinreihen(datum = new Date().toISOString().slice(0, 10)): Promise<string> {
  const eintraege = await cockpitLaden(sql, { finanzen: true })
  const nutzer = await sql<{ id: string; name: string }[]>`select id, name from users`
  const namen = Object.fromEntries(nutzer.map((u) => [u.id, u.name]))
  const basisUrl =
    process.env.ERP_PUBLIC_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)

  const text = digestText(eintraege, namen, { datum, basisUrl })
  if (!text) return 'Nichts offen — keine Nachricht'
  const id = await einreihen(sql, 'einkauf', `einkauf:${datum}`, text)
  return id ? `Zusammenfassung eingereiht (${eintraege.length} Einträge im Cockpit)` : 'Die Zusammenfassung für heute ist schon gesendet'
}
