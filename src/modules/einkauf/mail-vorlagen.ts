/**
 * Mail-Vorlagen und Sprache (0094), pur: die Vorlagen je Anlass und
 * Sprache (de/en/zh, Tabelle `mail_vorlagen`) tragen Platzhalter wie
 * {{bestellnummer}}; fehlt ein Wert, bleibt „[bestellnummer]" sichtbar
 * stehen, damit niemand eine halbe Mail verschickt. Dazu eine schlichte
 * Spracherkennung für eingehende Mails (übersetzt wird, was nicht deutsch
 * ist).
 */

export const VORLAGEN_ANLAESSE = {
  anfrage: 'Preis-/Angebotsanfrage',
  pi_anfordern: 'PI / Rechnung anfordern',
  liefertermin: 'Liefertermin & Tracking',
  muster_feedback: 'Muster-Feedback',
  bestellung: 'Bestellung senden',
} as const
export type VorlagenAnlass = keyof typeof VORLAGEN_ANLAESSE
export const VORLAGEN_ANLASS_NAMEN = Object.keys(VORLAGEN_ANLAESSE) as [VorlagenAnlass, ...VorlagenAnlass[]]

export const SPRACHEN = { de: 'Deutsch', en: 'Englisch', zh: 'Chinesisch' } as const
export type Sprache = keyof typeof SPRACHEN

export const PLATZHALTER = ['lieferant', 'ansprechpartner', 'bestellnummer', 'liefertermin', 'einkaeufer', 'firma'] as const

/** {{name}} ersetzen; unbekannte oder leere bleiben als [name] stehen. */
export function vorlageFuellen(text: string, werte: Partial<Record<string, string | null | undefined>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    const w = werte[name]
    return w && w.trim() ? w : `[${name}]`
  })
}

/** Offene Platzhalter („[bestellnummer]") im fertigen Text — vor dem Senden eine Warnung wert. */
export function offenePlatzhalter(text: string): string[] {
  const namen = new Set<string>()
  for (const m of text.matchAll(/\[([a-z_]+)\]/g)) {
    if ((PLATZHALTER as readonly string[]).includes(m[1])) namen.add(m[1])
  }
  return [...namen]
}

const CJK = /[㐀-鿿豈-﫿]/g
const DEUTSCH = /\b(und|der|die|das|nicht|bitte|wir|ihr|ihnen|mit|für|vielen|dank|grüße|gruß|bestellung|lieferung)\b|[äöüß]/gi

/** zh, wenn nennenswert Hanzi vorkommen; de bei deutschen Wörtern; sonst en; zu wenig Text → null. */
export function spracheErkennen(text: string | null | undefined): Sprache | null {
  const t = (text ?? '').slice(0, 4000)
  const buchstaben = t.replace(/[\s\d\p{P}\p{S}]/gu, '').length
  if (buchstaben < 8) return null
  const hanzi = t.match(CJK)?.length ?? 0
  if (hanzi / buchstaben > 0.15) return 'zh'
  const woerter = t.split(/\s+/).length
  const deutsch = t.match(DEUTSCH)?.length ?? 0
  if (deutsch / Math.max(woerter, 1) > 0.06) return 'de'
  return 'en'
}
