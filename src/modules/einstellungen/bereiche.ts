/**
 * Die Landkarte der Einstellungen — EINE Quelle für die linke
 * Unternavigation, die Seitenköpfe und den Wächter (tests/einstellungen.test.ts).
 *
 * Regel (Entscheidungslog 2026-09-26): ein Bereich je Thema, eine Seite je
 * Bereich, Reihenfolge = Navigation. Konfiguration steht oben, Verwaltung
 * (Bericht, Posteingang) darunter, die Gefahrenzone immer zuletzt. Wer eine
 * Seite unter /einstellungen anlegt, trägt sie hier ein — sonst wird die
 * Suite rot.
 *
 * Bewusst ohne Importe: pure Daten, unter blankem Node testbar.
 */

export type Gruppe = 'Organisation' | 'Abläufe' | 'Anbindungen' | 'Verwaltung'

export const GRUPPEN: readonly Gruppe[] = ['Organisation', 'Abläufe', 'Anbindungen', 'Verwaltung']

export interface Bereich {
  href: string
  label: string
  gruppe: Gruppe
  /** Ein Satz: was hier eingestellt wird und worauf es wirkt — der Untertitel der Seite. */
  beschreibung: string
  /** Destruktiv — in der Navigation rot abgesetzt. */
  gefahr?: true
}

export const EINSTELLUNGS_BEREICHE: readonly Bereich[] = [
  {
    href: '/einstellungen',
    label: 'Firma',
    gruppe: 'Organisation',
    beschreibung: 'Firmendaten — Absender auf DHL-Labels, Belegen und Mails.',
  },
  {
    href: '/einstellungen/benutzer',
    label: 'Benutzer',
    gruppe: 'Organisation',
    beschreibung: 'Konten, Rollen und Befugnisse; Passwort und zweiten Faktor zurücksetzen.',
  },
  {
    href: '/einstellungen/sicherheit',
    label: 'Sicherheit',
    gruppe: 'Organisation',
    beschreibung: 'Pflicht für den zweiten Faktor und die Regeln der Anmeldung.',
  },
  {
    href: '/einstellungen/belege',
    label: 'Belege & Freigaben',
    gruppe: 'Abläufe',
    beschreibung: 'Sperren beim Bestätigen, Freigabegrenze im Einkauf und die Nummernkreise.',
  },
  {
    href: '/einstellungen/versand',
    label: 'Versand & Druck',
    gruppe: 'Abläufe',
    beschreibung: 'Labelformat und Druckweg für Labels und Fertigungszettel.',
  },
  {
    href: '/einstellungen/versandregeln',
    label: 'Versandregeln',
    gruppe: 'Abläufe',
    beschreibung: 'Von oben nach unten ausgewertet — je Aktion gewinnt die erste passende Regel.',
  },
  {
    href: '/einstellungen/kartonagen',
    label: 'Kartonagen',
    gruppe: 'Abläufe',
    beschreibung: 'Verpackung wählen, Gewicht mitrechnen, Verbrauch buchen.',
  },
  {
    href: '/einstellungen/finanzen',
    label: 'Finanzen',
    gruppe: 'Abläufe',
    beschreibung: 'Stellschrauben der Cashflow-Prognose: Quoten, Sätze, Zahltage, Szenario-Band.',
  },
  {
    href: '/einstellungen/anbindungen',
    label: 'Schnittstellen',
    gruppe: 'Anbindungen',
    beschreibung: 'Shopify, DHL, E-Mail, KI und Telegram: Stand der Anbindung und ihr Verhalten.',
  },
  {
    href: '/einstellungen/benachrichtigungen',
    label: 'Benachrichtigungen',
    gruppe: 'Anbindungen',
    beschreibung: 'Was als Telegram-Nachricht aufs Telefon geht — Anmeldungen, Fehlversuche, Störungen.',
  },
  {
    href: '/einstellungen/ki',
    label: 'KI-Modelle',
    gruppe: 'Anbindungen',
    beschreibung: 'Welches Modell je KI-Ebene arbeitet — Kosten und Qualität abwägen.',
  },
  {
    href: '/einstellungen/nutzung',
    label: 'Nutzung',
    gruppe: 'Verwaltung',
    beschreibung: 'Aktive Nutzer, Belege und KI-Nutzung je Monat — die Grundlage für Preisgespräche.',
  },
  {
    href: '/einstellungen/registrierungen',
    label: 'Registrierungen',
    gruppe: 'Verwaltung',
    beschreibung: 'Interessenten von der öffentlichen Startseite.',
  },
  {
    href: '/einstellungen/gefahrenzone',
    label: 'Gefahrenzone',
    gruppe: 'Verwaltung',
    beschreibung: 'Betriebsdaten löschen oder den Werkszustand herstellen — endgültig.',
    gefahr: true,
  },
]

/** Der Bereich zu einem Pfad — wirft, damit ein Tippfehler im Seitenkopf sofort auffällt. */
export function bereichZu(href: string): Bereich {
  const b = EINSTELLUNGS_BEREICHE.find((x) => x.href === href)
  if (!b) throw new Error(`Einstellungsbereich ${href} fehlt in src/modules/einstellungen/bereiche.ts`)
  return b
}

/**
 * Aktiver Bereich zu einem Pfad: der längste passende — die Wurzel
 * (/einstellungen = Firma) nur bei exaktem Treffer.
 */
export function aktiverBereich(pathname: string): string | undefined {
  return EINSTELLUNGS_BEREICHE.map((b) => b.href)
    .filter((href) =>
      href === '/einstellungen'
        ? pathname === href
        : pathname === href || pathname.startsWith(href + '/'),
    )
    .sort((a, b) => b.length - a.length)[0]
}
