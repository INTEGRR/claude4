import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238) auf HOTP (RFC 4226): HMAC-SHA1, sechs Stellen, Schritte
 * von 30 Sekunden — das Standardprofil aller Authenticator-Apps (Google
 * Authenticator, Authy, 1Password, Bitwarden …).
 *
 * Bewusst ohne Bibliothek und ohne App-Importe: unter blankem Node testbar,
 * geprüft gegen die Vektoren aus RFC 6238 Anhang B (tests/totp.test.ts).
 * Hier steht nur Rechnerei — kein Datenbankzugriff, kein Zustand.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const SCHRITT_SEKUNDEN = 30
export const STELLEN = 6

// --- Base32 (RFC 4648, ohne Padding — so tragen es die Apps) ---------------

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let wert = 0
  let aus = ''
  for (const b of bytes) {
    wert = ((wert << 8) | b) & 0x1fff
    bits += 8
    while (bits >= 5) {
      aus += ALPHABET[(wert >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) aus += ALPHABET[(wert << (5 - bits)) & 31]
  return aus
}

export function base32Decode(text: string): Buffer {
  const sauber = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  const aus: number[] = []
  let bits = 0
  let wert = 0
  for (const zeichen of sauber) {
    const idx = ALPHABET.indexOf(zeichen)
    if (idx < 0) throw new Error(`Ungültiges Base32-Zeichen: ${zeichen}`)
    wert = ((wert << 5) | idx) & 0xfff
    bits += 5
    if (bits >= 8) {
      aus.push((wert >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(aus)
}

// --- HOTP / TOTP -----------------------------------------------------------

/** RFC 4226: HMAC-SHA1 über den 8-Byte-Zähler, dynamische Kürzung, sechs Stellen. */
export function hotp(secret: Buffer, zaehler: number): string {
  const puffer = Buffer.alloc(8)
  puffer.writeBigUInt64BE(BigInt(zaehler))
  const h = createHmac('sha1', secret).update(puffer).digest()
  const offset = h[h.length - 1] & 0x0f
  const bin =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff)
  return String(bin % 10 ** STELLEN).padStart(STELLEN, '0')
}

/** Der 30-Sekunden-Schritt zu einem Zeitpunkt (Unix-Zeit / 30). */
export function totpSchritt(zeitMs = Date.now()): number {
  return Math.floor(zeitMs / 1000 / SCHRITT_SEKUNDEN)
}

export function totp(secretBase32: string, zeitMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpSchritt(zeitMs))
}

/** Leerzeichen und Bindestriche raus, Kleinschreibung — für Codes aus Formularen. */
export function codeNormalisieren(eingabe: string): string {
  return eingabe.replace(/[\s-]/g, '').toLowerCase()
}

/** Sechs Ziffern = Code aus der App; alles andere kann nur ein Backup-Code sein. */
export function istTotpCode(eingabe: string): boolean {
  return /^\d{6}$/.test(codeNormalisieren(eingabe))
}

/**
 * Prüft einen Code im Fenster ±`fenster` Schritte (Uhrenabweichung) und
 * liefert den getroffenen Schritt — oder null. Schritte bis einschließlich
 * `letzterSchritt` sind verbraucht: derselbe Code gilt nur einmal, und ein
 * älterer Code nach einem neueren gar nicht mehr (Replay-Schutz).
 */
export function totpPruefen(
  secretBase32: string,
  code: string,
  opts: { zeitMs?: number; fenster?: number; letzterSchritt?: number | null } = {},
): number | null {
  const eingabe = codeNormalisieren(code)
  if (!/^\d{6}$/.test(eingabe)) return null
  const secret = base32Decode(secretBase32)
  const mitte = totpSchritt(opts.zeitMs ?? Date.now())
  const fenster = opts.fenster ?? 1
  for (let d = -fenster; d <= fenster; d++) {
    const schritt = mitte + d
    if (opts.letzterSchritt != null && schritt <= opts.letzterSchritt) continue
    const erwartet = hotp(secret, schritt)
    if (timingSafeEqual(Buffer.from(erwartet), Buffer.from(eingabe))) return schritt
  }
  return null
}

// --- Einrichtung -----------------------------------------------------------

/** 20 Zufallsbytes (160 Bit, die RFC-Empfehlung für SHA1) als Base32 — 32 Zeichen. */
export function geheimnisErzeugen(): string {
  return base32Encode(randomBytes(20))
}

/** Zum Abtippen: Vierergruppen, wie es die Apps anzeigen. */
export function geheimnisFormatieren(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim()
}

/**
 * otpauth-URL für den QR-Code. Label = „Aussteller:Konto", Aussteller
 * zusätzlich als Parameter (so wollen es die Apps); Algorithmus, Stellen und
 * Schritt ausdrücklich, obwohl es die Standardwerte sind.
 */
export function otpauthUrl(konto: string, aussteller: string, secretBase32: string): string {
  const label = encodeURIComponent(`${aussteller}:${konto}`)
  const params = [
    `secret=${secretBase32}`,
    `issuer=${encodeURIComponent(aussteller)}`,
    'algorithm=SHA1',
    `digits=${STELLEN}`,
    `period=${SCHRITT_SEKUNDEN}`,
  ]
  return `otpauth://totp/${label}?${params.join('&')}`
}

/** Zeichenvorrat ohne verwechselbare Zeichen (0/o, 1/l/i) — Codes werden abgetippt. */
const CODE_ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * Backup-Codes „xxxx-xxxx": 31 Zeichen hoch 8 ≈ 2^39 Möglichkeiten, jeder
 * gilt einmal. Verwerfungs-Stichprobe statt Modulo, damit kein Zeichen
 * bevorzugt wird.
 */
export function backupCodesErzeugen(anzahl = 10): string[] {
  const grenze = 256 - (256 % CODE_ZEICHEN.length)
  const codes = new Set<string>()
  while (codes.size < anzahl) {
    const zeichen: string[] = []
    while (zeichen.length < 8) {
      for (const b of randomBytes(16)) {
        if (b < grenze && zeichen.length < 8) zeichen.push(CODE_ZEICHEN[b % CODE_ZEICHEN.length])
      }
    }
    codes.add(`${zeichen.slice(0, 4).join('')}-${zeichen.slice(4).join('')}`)
  }
  return [...codes]
}
