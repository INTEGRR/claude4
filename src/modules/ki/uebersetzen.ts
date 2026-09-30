import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import { kiModell } from './modelle.ts'

/**
 * Übersetzung im Einkauf (0094) — kleine KI-Arbeit, aber mit Ansage: Zahlen,
 * Maße, Teilenummern, Incoterms und Zeilenumbrüche bleiben, der Ton ist
 * höflich-geschäftlich. Jeder Aufruf landet mit seinen Tokens in
 * `ki_verbrauch`. KI_FAKE=1 (Tests, Staging, Browsertest) übersetzt nicht,
 * sondern markiert nur — deterministisch und ohne Schlüssel.
 */

export type ZielSprache = 'de' | 'en' | 'zh'

const SPRACH_NAMEN: Record<ZielSprache, string> = {
  de: 'Deutsch',
  en: 'Englisch (Business English)',
  zh: 'vereinfachtes Chinesisch (简体中文, höflicher Geschäftston)',
}

export function kiFake(): boolean {
  return process.env.KI_FAKE === '1'
}

export function uebersetzungMoeglich(): boolean {
  return kiFake() || Boolean(process.env.ANTHROPIC_API_KEY)
}

export interface Uebersetzung {
  text: string
  modell: string
  inputTokens: number
  outputTokens: number
}

export async function uebersetzen(
  text: string,
  ziel: ZielSprache,
  bezug: { zweck: string; modell?: string; recordId?: string },
): Promise<Uebersetzung> {
  const quelle = text.trim()
  if (!quelle) return { text: '', modell: 'keins', inputTokens: 0, outputTokens: 0 }

  let ergebnis: Uebersetzung
  if (kiFake()) {
    ergebnis = { text: `[${ziel}] ${quelle}`, modell: 'fake', inputTokens: 0, outputTokens: 0 }
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Übersetzen braucht die KI — ANTHROPIC_API_KEY ist nicht gesetzt.')
    }
    const modell = await kiModell(sql, 'uebersetzung')
    const antwort = await new Anthropic().messages.create({
      model: modell,
      max_tokens: 8000,
      system:
        `Du übersetzt Geschäftskorrespondenz aus dem Einkauf eines deutschen Hardware-Herstellers ` +
        `(Platinen, Sensoren, Keycaps, CNC-, Laser- und Spritzgussteile, Verpackung, Schaumstoff) nach ` +
        `${SPRACH_NAMEN[ziel]}. Übersetze sinngetreu und vollständig. Zahlen, Preise, Währungen, Maße, ` +
        `Toleranzen, Teile- und Bestellnummern, Incoterms, Namen, Adressen, Links und Tracking-Nummern ` +
        `bleiben unverändert. Behalte Absätze, Aufzählungen und Zeilenumbrüche bei. Gib ausschließlich ` +
        `die Übersetzung aus — keine Anmerkungen, keine Anführungszeichen drumherum.`,
      messages: [{ role: 'user', content: quelle }],
    })
    const uebersetzt = antwort.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    ergebnis = {
      text: uebersetzt,
      modell,
      inputTokens: antwort.usage.input_tokens,
      outputTokens: antwort.usage.output_tokens,
    }
  }

  await sql`
    insert into ki_verbrauch (ebene, modell, zweck, modell_bezug, record_id, input_tokens, output_tokens)
    values ('uebersetzung', ${ergebnis.modell}, ${bezug.zweck}, ${bezug.modell ?? null}, ${bezug.recordId ?? null},
            ${ergebnis.inputTokens}, ${ergebnis.outputTokens})`
  return ergebnis
}
