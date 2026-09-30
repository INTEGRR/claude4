/**
 * Regeln für die Mail-Zuordnung (0093), pur: Freemailer (qq.com, 163.com,
 * gmail.com …) sagen über den Lieferanten nichts — viele chinesische
 * Lieferanten schreiben von privaten Adressen. Für sie merkt sich die
 * Lieferantenakte die volle Adresse statt der Domain; die SQL-Regel
 * `mail_thread_zuordnen` prüft beides (volle Adresse gewinnt).
 */

export const FREEMAIL_DOMAINS = new Set([
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', '139.com', '189.cn',
  'aliyun.com', 'sina.com', 'sina.cn', 'sohu.com', 'tom.com',
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'yandex.com',
  'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'freenet.de',
])

export function istFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.trim().toLowerCase())
}

export const DOMAIN_MUSTER = /^[a-z0-9.-]+\.[a-z]{2,}$/
export const ADRESS_MUSTER = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/

/** Fehlertext für einen Eintrag der Lieferantenakte — null, wenn er taugt. */
export function mailKennungFehler(eintrag: string): string | null {
  const e = eintrag.trim().toLowerCase()
  if (ADRESS_MUSTER.test(e)) return null
  if (!DOMAIN_MUSTER.test(e)) return `„${eintrag}" ist weder Maildomain noch Adresse`
  if (istFreemail(e)) return `${e} ist ein Freemailer — bitte die volle Adresse eintragen (z. B. sales@${e})`
  return null
}

/** Was sich die Lieferantenakte für diesen Absender merkt: Domain, bei Freemailern die Adresse. */
export function absenderKennung(email: string): string {
  const e = email.trim().toLowerCase()
  const domain = e.split('@')[1] ?? ''
  return istFreemail(domain) ? e : domain
}

/** Eigene Domain des Einkaufspostfachs — Mails von dort sind intern (Weiterleitung, Kollegen). */
export function domainVon(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase().split('@')[1] ?? ''
}
