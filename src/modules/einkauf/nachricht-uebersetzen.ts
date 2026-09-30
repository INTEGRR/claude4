import { sql } from '@/db/client'
import { uebersetzen, uebersetzungMoeglich } from '@/modules/ki/uebersetzen'
import { spracheErkennen } from './mail-vorlagen.ts'

/**
 * Eingegangene Nachrichten ins Deutsche (0094): der Abgleich reiht
 * chinesische Mails als Job `mail_uebersetzen` ein, der Knopf im Thread
 * übersetzt jede andere auf Wunsch. Ohne KI (kein Schlüssel, kein Fake)
 * wird still übersprungen — der Originaltext bleibt ja lesbar.
 */
export async function nachrichtUebersetzen(nachrichtId: string, erzwingen = false): Promise<string> {
  const [n] = await sql<{ id: string; text: string | null; text_de: string | null; sprache: string | null }[]>`
    select id, text, text_de, sprache from mail_nachrichten where id = ${nachrichtId}`
  if (!n) return 'Nachricht nicht mehr vorhanden'
  if (n.text_de && !erzwingen) return 'Schon übersetzt'
  if (!n.text?.trim()) return 'Kein Text zum Übersetzen'
  const sprache = n.sprache ?? spracheErkennen(n.text)
  if (sprache === 'de' && !erzwingen) return 'Schon deutsch'
  if (!uebersetzungMoeglich()) return 'Übersprungen — KI nicht konfiguriert'
  const u = await uebersetzen(n.text, 'de', { zweck: 'uebersetzung_eingang', modell: 'mail_nachricht', recordId: n.id })
  await sql`update mail_nachrichten set text_de = ${u.text}, sprache = coalesce(sprache, ${sprache}) where id = ${n.id}`
  return `Übersetzt (${u.modell}, ${u.inputTokens + u.outputTokens} Token)`
}
