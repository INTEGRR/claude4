import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Verschlüsselung ruhender Geheimnisse (TOTP-Geheimnisse, Einrichtungs-
 * Entwürfe): AES-256-GCM, Schlüssel aus ZWEIFAKTOR_SCHLUESSEL oder — als
 * Rückfall — SESSION_SECRET. Kein stiller Standardwert wie bei kennungHash:
 * ohne Schlüssel gibt es keinen zweiten Faktor, und das soll laut scheitern.
 *
 * Eigene Variable, damit SESSION_SECRET sich ändern darf, ohne dass die
 * Telefone neu eingerichtet werden müssen. Schlüsselwechsel ohne
 * Neueinrichtung (Entscheidungslog 2026-10-01): entschlüsselt wird mit dem
 * aktuellen Schlüssel und — scheitert das — mit den alten
 * (ZWEIFAKTOR_SCHLUESSEL_ALT, SESSION_SECRET aus der Zeit vor der eigenen
 * Variable). Wer mit einem alten Schlüssel gelesen wurde, wird beim nächsten
 * gültigen Code mit dem aktuellen neu verschlüsselt (zweifaktor.ts).
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

/**
 * Frühere Schlüssel, die beim Lesen noch gelten: ZWEIFAKTOR_SCHLUESSEL_ALT
 * (nach einer Rotation) und SESSION_SECRET, sobald ZWEIFAKTOR_SCHLUESSEL
 * gesetzt ist — Geheimnisse von davor sind mit SESSION_SECRET verschlüsselt.
 */
export function alteSchluessel(env: Record<string, string | undefined> = process.env): Buffer[] {
  const aktuell = env.ZWEIFAKTOR_SCHLUESSEL || env.SESSION_SECRET
  const kandidaten = [env.ZWEIFAKTOR_SCHLUESSEL_ALT, env.ZWEIFAKTOR_SCHLUESSEL ? env.SESSION_SECRET : undefined]
  return [...new Set(kandidaten.filter((k): k is string => Boolean(k) && k !== aktuell))].map((k) =>
    createHash('sha256').update(k).digest(),
  )
}

/**
 * Entschlüsseln mit Rückfall auf die alten Schlüssel. `veraltet` sagt, ob ein
 * alter Schlüssel gebraucht wurde — dann sollte der Aufrufer neu
 * verschlüsseln. Scheitern alle, scheitert es laut wie `entschluesseln`.
 */
export function entschluesselnMitRueckfall(
  blob: string,
  env: Record<string, string | undefined> = process.env,
): { klartext: string; veraltet: boolean } {
  try {
    return { klartext: entschluesseln(blob, schluesselAusUmgebung(env)), veraltet: false }
  } catch (fehler) {
    for (const alt of alteSchluessel(env)) {
      try {
        return { klartext: entschluesseln(blob, alt), veraltet: true }
      } catch {
        // nächster Kandidat
      }
    }
    throw fehler
  }
}

