import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Verschlüsselung ruhender Geheimnisse (TOTP-Geheimnisse, Einrichtungs-
 * Entwürfe): AES-256-GCM, Schlüssel aus ZWEIFAKTOR_SCHLUESSEL oder — als
 * Rückfall — SESSION_SECRET. Kein stiller Standardwert wie bei kennungHash:
 * ohne Schlüssel gibt es keinen zweiten Faktor, und das soll laut scheitern.
 *
 * Folge für den Betrieb: wer den Schlüssel rotiert, macht alle TOTP-
 * Geheimnisse unlesbar — jeder Benutzer richtet dann neu ein (Doku:
 * vercel-supabase.md, go-live.md). Deshalb die eigene Variable: SESSION_SECRET
 * darf sich ändern, ohne dass die Telefone neu eingerichtet werden müssen.
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>` (base64url) — versioniert, damit ein
 * späteres Verfahren alte Blobs erkennt.
 */

export function schluesselAusUmgebung(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const quelle = env.ZWEIFAKTOR_SCHLUESSEL || env.SESSION_SECRET
  if (!quelle) {
    throw new Error(
      'ZWEIFAKTOR_SCHLUESSEL oder SESSION_SECRET fehlt — ohne Schlüssel kein zweiter Faktor',
    )
  }
  return createHash('sha256').update(quelle).digest()
}

export function verschluesseln(klartext: string, schluessel: Buffer = schluesselAusUmgebung()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', schluessel, iv)
  const ct = Buffer.concat([cipher.update(klartext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':')
}

export function entschluesseln(blob: string, schluessel: Buffer = schluesselAusUmgebung()): string {
  const [version, ivB, tagB, ctB] = blob.split(':')
  if (version !== 'v1' || !ivB || !tagB || ctB === undefined) {
    throw new Error('Unbekanntes Geheimnisformat')
  }
  const decipher = createDecipheriv('aes-256-gcm', schluessel, Buffer.from(ivB, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString(
    'utf8',
  )
}
