import type { Area, Role } from './auth/permissions'
import { canAccess } from './auth/permissions'
import { REGISTRY } from './prozesse/registry'
import { aktionErlaubt } from './prozesse/torwaechter'

/**
 * Katalog fürs Befehlsfeld — EINE Quelle für Übersicht und das globale
 * Strg/Cmd+K-Overlay: welche Aktionen (frei gebunden, rollenerlaubt) und
 * welche Seiten (Spiegel der Navigation, prozessgefiltert) sich tippen
 * lassen. Belege kommen zur Laufzeit über /api/suche dazu.
 */

export interface BefehlsAktion {
  name: string
  label: string
  bereich: string
}

export interface BefehlsSeite {
  href: string
  label: string
}

/** Seitenkatalog — Spiegel der Navigation (layout.tsx). */
const SEITEN: { href: string; label: string; area: Area; prozess?: string[] }[] = [
  { href: '/verkauf', label: 'Verkaufsaufträge', area: 'verkauf' },
  { href: '/verkauf/neu', label: 'Neuer Verkaufsauftrag', area: 'verkauf' },
  { href: '/vorgaenge', label: 'Vorgänge', area: 'verkauf' },
  { href: '/versand', label: 'Versand', area: 'versand', prozess: ['versand'] },
  { href: '/fertigung', label: 'Fertigungsaufträge', area: 'fertigung', prozess: ['fertigung'] },
  { href: '/fertigung/stuecklisten', label: 'Stücklisten', area: 'fertigung', prozess: ['fertigung'] },
  { href: '/einkauf', label: 'Bestellungen', area: 'einkauf', prozess: ['einkauf'] },
  { href: '/einkauf/rechnungen', label: 'Lieferantenrechnungen', area: 'einkauf', prozess: ['einkauf'] },
  { href: '/lager', label: 'Transfers', area: 'lager' },
  { href: '/lager/zulauf', label: 'Zulauf (Wareneingangskalender)', area: 'lager' },
  { href: '/lager/bestand', label: 'Bestand', area: 'lager' },
  { href: '/lager/bewertung', label: 'Bewertung', area: 'lager' },
  { href: '/lager/beschaffung', label: 'Beschaffung', area: 'lager', prozess: ['einkauf', 'fertigung'] },
  { href: '/lager/lose', label: 'Lose & Serien', area: 'lager' },
  { href: '/lager/inventur', label: 'Inventur', area: 'lager' },
  { href: '/reparatur', label: 'Reparaturen', area: 'reparatur', prozess: ['reparatur'] },
  { href: '/zeiterfassung', label: 'Zeiterfassung', area: 'zeiterfassung' },
  { href: '/personal', label: 'Mitarbeiter', area: 'personal' },
  { href: '/personal/schichtplan', label: 'Schichtplan', area: 'personal' },
  { href: '/personal/abwesenheiten', label: 'Abwesenheiten', area: 'personal' },
  { href: '/auswertungen', label: 'Auswertungen: Mengen & Abverkauf', area: 'auswertungen' },
  { href: '/auswertungen/kennzahlen', label: 'Kennzahlen', area: 'auswertungen' },
  { href: '/ki', label: 'KI-Analyse', area: 'ki' },
  { href: '/produkte', label: 'Produkte', area: 'produkte' },
  { href: '/kontakte', label: 'Kontakte', area: 'kontakte' },
  { href: '/scanner', label: 'Scanner', area: 'scanner' },
  { href: '/integrationen', label: 'Integrationen', area: 'integrationen' },
  { href: '/prozesse', label: 'Prozesse', area: 'einstellungen' },
  { href: '/einstellungen', label: 'Einstellungen', area: 'einstellungen' },
  { href: '/einstellungen/benutzer', label: 'Benutzer verwalten', area: 'einstellungen' },
  { href: '/tickets', label: 'Tickets', area: 'fehler' },
]

export function befehlsKatalog(
  role: Role,
  prozessAktiv: (bereich: string) => boolean,
): { aktionen: BefehlsAktion[]; seiten: BefehlsSeite[] } {
  const aktionen = Object.entries(REGISTRY)
    .filter(([, a]) => a.bindung === 'frei' && aktionErlaubt(a, role))
    .map(([name, a]) => ({ name, label: a.label, bereich: a.bereich }))
  const seiten = SEITEN.filter(
    (p) => canAccess(role, p.area) && (!p.prozess || p.prozess.some((b) => prozessAktiv(b))),
  ).map(({ href, label }) => ({ href, label }))
  return { aktionen, seiten }
}
