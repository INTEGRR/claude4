/**
 * Produktivgang (Entscheidungslog 2026-10-17, Go-live über den API-Weg):
 * die Checkliste, die sich selbst prüft. Jeder Prüfpunkt bewertet einen
 * eingesammelten Stand zu einer Ampel — rot (warn) heißt „vor dem Stichtag
 * erledigen", grau (off) „bewusst noch nicht", grün (ok) „bereit".
 * Was KRNL nicht sehen kann (PITR, AV-Vertrag, Domain …), steht als
 * Handarbeit mit Verweis auf docs/go-live.md daneben.
 *
 * Pur (Stand als Parameter), damit unter blankem Node testbar; das
 * Einsammeln macht die Seite /einstellungen/produktivgang.
 */
import { ANBINDUNGEN, type Anbindung, anbindungsStand } from './umgebung.ts'

type Env = Record<string, string | undefined>

export type Ampel = 'ok' | 'warn' | 'off'

export interface ProduktivgangStand {
  env: Env
  /** settings.company (Rechnungsfuß, Absender). */
  firma: Record<string, string | undefined>
  /** sequence_state(): nächster Wert je Nummernkreis. */
  nummernkreise: { code: string; next_number: number }[]
  rechnungModus: 'aus' | 'test' | 'scharf'
  probeRechnungen: number
  shopifyModus: 'lesen' | 'probe' | 'schreiben'
  /** Dienste-Wächter: Dienste, die gerade als gestört gelten. */
  gestoerteDienste: string[]
  /** settings.ki_region ausdrücklich gesetzt (sonst gilt die Vorgabe). */
  kiRegionGesetzt: boolean
  kiRegionBereit: boolean
  /** Aktive Administratoren ohne zweiten Faktor. */
  adminsOhne2fa: number
  /** Das Startkonto admin@example.com ist noch aktiv. */
  startkontoAktiv: boolean
  /** Offene Einrichtungsaufgaben (Stichtag-Todos, 0116). */
  offeneEinrichtung: number
}

export interface Ergebnis {
  ton: Ampel
  text: string
}

export interface Pruefpunkt {
  schluessel: string
  titel: string
  gruppe: 'Betrieb' | 'Firma & Belege' | 'Shopify' | 'Anbindungen' | 'Konten'
  link: string
  bewerten: (s: ProduktivgangStand) => Ergebnis
}

/** Pflichtangaben im Rechnungsfuß einer GmbH (§ 35a GmbHG, § 14 Abs. 4 UStG). */
export const FIRMA_PFLICHTFELDER = [
  ['name', 'Firmenname'],
  ['street', 'Straße'],
  ['zip', 'PLZ'],
  ['city', 'Ort'],
  ['ust_id', 'USt-IdNr.'],
  ['steuernummer', 'Steuernummer'],
  ['registergericht', 'Registergericht'],
  ['handelsregister', 'Handelsregister'],
  ['geschaeftsfuehrung', 'Geschäftsführung'],
  ['iban', 'IBAN'],
] as const

/** Name, den der Werkszustand einträgt — gilt als „noch nicht eingerichtet". */
export const PLATZHALTER_FIRMA = 'Meine Firma GmbH'

const ok = (text: string): Ergebnis => ({ ton: 'ok', text })
const rot = (text: string): Ergebnis => ({ ton: 'warn', text })
const grau = (text: string): Ergebnis => ({ ton: 'off', text })

function anbindung(s: ProduktivgangStand, schluessel: Anbindung['schluessel'], titel: string): Ergebnis {
  const a = ANBINDUNGEN.find((x) => x.schluessel === schluessel)!
  const stand = anbindungsStand(a, s.env)
  if (stand.fake) return rot(`${titel}: Attrappe aktiv (${a.fake}=1) — vor dem Stichtag abschalten`)
  if (!stand.vollstaendig) return rot(`${titel}: es fehlt ${stand.fehlend.join(', ')}`)
  if (s.gestoerteDienste.includes(schluessel)) return rot(`${titel}: konfiguriert, aber der Dienste-Wächter meldet eine Störung`)
  return ok(`${titel}: konfiguriert`)
}

function nummernkreis(s: ProduktivgangStand, code: string): number | null {
  const n = s.nummernkreise.find((k) => k.code === code)
  return n ? Number(n.next_number) : null
}

export const PRUEFPUNKTE: readonly Pruefpunkt[] = [
  {
    schluessel: 'betrieb',
    titel: 'Betriebs-Geheimnisse',
    gruppe: 'Betrieb',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => {
      const stand = anbindungsStand(ANBINDUNGEN.find((a) => a.schluessel === 'system')!, s.env)
      return stand.vollstaendig ? ok('CRON_SECRET und SESSION_SECRET gesetzt') : rot(`es fehlt ${stand.fehlend.join(', ')}`)
    },
  },
  {
    schluessel: 'firma',
    titel: 'Firmendaten vollständig',
    gruppe: 'Firma & Belege',
    link: '/einstellungen',
    bewerten: (s) => {
      if (!s.firma.name?.trim() || s.firma.name.trim() === PLATZHALTER_FIRMA) return rot('Firmenname ist noch der Platzhalter')
      const fehlen = FIRMA_PFLICHTFELDER.filter(([k]) => !s.firma[k]?.trim()).map(([, label]) => label)
      return fehlen.length ? rot(`es fehlt ${fehlen.join(', ')}`) : ok('alle Pflichtangaben für den Rechnungsfuß gesetzt')
    },
  },
  {
    schluessel: 'nummernkreise',
    titel: 'Nummernkreise RE- und GU- fortgesetzt',
    gruppe: 'Firma & Belege',
    link: '/einstellungen/belege',
    bewerten: (s) => {
      const re = nummernkreis(s, 'kundenrechnung')
      const gu = nummernkreis(s, 'gutschrift')
      const offen = [re === null || re <= 1 ? 'RE-' : null, gu === null || gu <= 1 ? 'GU-' : null].filter(Boolean)
      return offen.length
        ? rot(`${offen.join(' und ')} beginnt noch bei 1 — auf die letzte sevDesk-Nummer + 1 setzen`)
        : ok(`nächste Nummern: RE-${re}, GU-${gu}`)
    },
  },
  {
    schluessel: 'rechnungsmodus',
    titel: 'Kundenrechnungen scharf',
    gruppe: 'Firma & Belege',
    link: '/einstellungen/belege',
    bewerten: (s) => {
      if (s.rechnungModus === 'aus') return rot('Rechnungen sind aus — KRNL stellt keine Rechnungen')
      if (s.rechnungModus === 'test') return rot('noch im Probelauf (Testbelege) — am Stichtag auf „scharf" schalten')
      return s.probeRechnungen > 0
        ? rot('scharf, aber es liegen noch Testbelege — im Probelauf löschen')
        : ok('scharf, keine Testbelege mehr')
    },
  },
  {
    schluessel: 'shopify',
    titel: 'Shopify verbunden',
    gruppe: 'Shopify',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => anbindung(s, 'shopify', 'Shopify'),
  },
  {
    schluessel: 'shopify_modus',
    titel: 'Shopify schreibt',
    gruppe: 'Shopify',
    link: '/einstellungen/anbindungen',
    bewerten: (s) =>
      s.shopifyModus === 'schreiben'
        ? ok('Bestand, Tracking und Fulfillment gehen an den Shop')
        : rot(s.shopifyModus === 'probe' ? 'noch im Probelauf — am Stichtag auf „schreiben"' : 'nur lesend — am Stichtag auf „schreiben"'),
  },
  {
    schluessel: 'dhl',
    titel: 'DHL-Versand',
    gruppe: 'Anbindungen',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => anbindung(s, 'dhl', 'DHL'),
  },
  {
    schluessel: 'mail',
    titel: 'E-Mail-Versand',
    gruppe: 'Anbindungen',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => anbindung(s, 'mail', 'E-Mail'),
  },
  {
    schluessel: 'track17',
    titel: 'Sendungsverfolgung (17TRACK)',
    gruppe: 'Anbindungen',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => {
      const e = anbindung(s, 'track17', '17TRACK')
      // Optional: ohne 17TRACK läuft der Zulauf von Hand weiter.
      return e.ton === 'warn' && !s.env.TRACK17_API_KEY?.trim() ? grau('nicht eingerichtet — Zulauf wird von Hand gepflegt') : e
    },
  },
  {
    schluessel: 'telegram',
    titel: 'Telegram-Meldungen',
    gruppe: 'Anbindungen',
    link: '/einstellungen/anbindungen',
    bewerten: (s) => {
      const e = anbindung(s, 'telegram', 'Telegram')
      return e.ton === 'warn' && !s.env.TELEGRAM_BOT_TOKEN?.trim() ? grau('nicht eingerichtet — Meldungen nur in KRNL') : e
    },
  },
  {
    schluessel: 'ki',
    titel: 'KI-Region entschieden',
    gruppe: 'Anbindungen',
    link: '/einstellungen/ki',
    bewerten: (s) => {
      if (!s.kiRegionGesetzt) return rot('noch nicht entschieden (EU über Bedrock oder Standard)')
      return s.kiRegionBereit ? ok('gewählt und der Zugang ist gesetzt') : rot('gewählt, aber der Zugang dafür fehlt')
    },
  },
  {
    schluessel: 'zwei_faktor',
    titel: 'Zweiter Faktor für Admins',
    gruppe: 'Konten',
    link: '/einstellungen/sicherheit',
    bewerten: (s) =>
      s.adminsOhne2fa > 0
        ? rot(`${s.adminsOhne2fa === 1 ? 'ein Admin hat' : `${s.adminsOhne2fa} Admins haben`} noch keinen zweiten Faktor`)
        : ok('alle Admins mit zweitem Faktor'),
  },
  {
    schluessel: 'startkonto',
    titel: 'Startkonto stillgelegt',
    gruppe: 'Konten',
    link: '/einstellungen/benutzer',
    bewerten: (s) =>
      s.startkontoAktiv ? rot('admin@example.com ist noch aktiv — deaktivieren') : ok('kein Startkonto mehr aktiv'),
  },
  {
    schluessel: 'einrichtung',
    titel: 'Einrichtungsaufgaben erledigt',
    gruppe: 'Konten',
    link: '/aufgaben',
    bewerten: (s) =>
      s.offeneEinrichtung > 0
        ? rot(`${s.offeneEinrichtung === 1 ? 'eine Aufgabe ist' : `${s.offeneEinrichtung} Aufgaben sind`} noch offen`)
        : ok('alle Stichtag-Aufgaben erledigt'),
  },
]

/** Was KRNL nicht prüfen kann — Häkchen dafür stehen in docs/go-live.md. */
export const HANDARBEIT: readonly { titel: string; text: string }[] = [
  { titel: 'Supabase-Sicherung', text: 'PITR aktiv, AV-Vertrag (DPA) abgeschlossen, Region EU (go-live.md §2)' },
  { titel: 'Vercel', text: 'Eigene Domain, Deployment-Schutz für Vorschauen, Variablen nur in Production (§3)' },
  { titel: 'Odoo', text: 'Selektive Übernahme (Stücklisten, Komponenten, Lieferanten, Bestände) abgeschlossen, danach schreibgeschützt (§5b, §7)' },
  { titel: 'sevDesk', text: 'Rechnungsausgabe der Shopify-App am Stichtag abschalten (§7c)' },
  { titel: 'Sendcloud', text: 'auslaufen lassen, bis keine alten Labels mehr unterwegs sind (§8)' },
]

export interface Bewertung extends Pruefpunkt, Ergebnis {}

export function produktivgangBewerten(s: ProduktivgangStand): Bewertung[] {
  return PRUEFPUNKTE.map((p) => ({ ...p, ...p.bewerten(s) }))
}
