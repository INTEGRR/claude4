import { redirect } from 'next/navigation'
import { currentUser, logout } from '@/modules/auth'
import { type Area, ROLE_LABELS, canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { AppShell } from '@/components/app-shell'
import { type NavGroup, SidebarNav } from '@/components/sidebar-nav'
import { ScanBox } from '@/components/scan-box'
import { AbmeldenKnopf } from '@/components/abmelden'
import { ThemeToggle } from '@/components/theme-toggle'
import { TicketOverlay } from '@/components/ticket-overlay'
import { KiOverlay } from '@/components/ki-overlay'
import { BefehlsOverlay } from '@/components/befehls-overlay'
import { Splash } from '@/components/splash'
import { HexcoreMark, Wortmarke } from '@/components/marke'
import { befehlsKatalog } from '@/modules/befehle'
import { kiConfigured } from '@/modules/ki/agent'
import { sprechenKonfiguriert } from '@/modules/ki/sprechen'

export const dynamic = 'force-dynamic'

async function signOut() {
  'use server'
  await logout()
  redirect('/login')
}

/** Zahlen an der Navigation: was liegt gerade an? */
async function badges() {
  const [row] = await sql<
    {
      offene_auftraege: number
      offene_mos: number
      offene_eingaenge: number
      versandbereit: number
      offene_reparaturen: number
      beschaffung: number
      anwesend: number
      abwesenheiten: number
      fehler: number
      offene_bugs: number
      faellige_zahlungen: number
      kuendigungen: number
    }[]
  >`
    select
      (select count(*) from sales_orders
        where state = 'sale' and delivery_status <> 'full')::int as offene_auftraege,
      (select count(*) from manufacturing_orders
        where state not in ('done','cancel'))::int as offene_mos,
      (select count(*) from stock_pickings p
         join operation_types ot on ot.id = p.operation_type_id
        where ot.kind = 'receipt' and p.state not in ('done','cancel'))::int as offene_eingaenge,
      (select count(*) from shipping_ready)::int as versandbereit,
      (select count(*) from repair_orders
        where state not in ('repaired','cancel'))::int as offene_reparaturen,
      (select count(*) from orderpoint_suggestions())::int as beschaffung,
      (select count(*) from employees_present)::int as anwesend,
      (select count(*) from absences where state = 'requested')::int as abwesenheiten,
      ((select count(*) from integration_jobs where status = 'failed')
       + (select count(*) from shopify_unmatched_lines where resolved_at is null))::int as fehler,
      (select count(*) from bug_reports
        where status in ('offen', 'in_arbeit'))::int as offene_bugs,
      (select count(*) from finanz_faellig(current_date + 7))::int as faellige_zahlungen,
      (select count(*) from vertraege v
        where vertrag_kuendigung_ansteht(v.id))::int as kuendigungen`
  return row
}

export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')

  // Erststart-Weiche: solange die Einrichtung offen ist (kein
  // settings-Schlüssel, Firmenname noch der Migrations-Default, nur ein
  // Benutzer), führt jeder Aufruf in den Assistenten. /einrichtung liegt
  // außerhalb dieser Layout-Gruppe — kein Redirect-Kreis; der Schlüssel
  // überlebt die Gefahrenzone, die Weiche kommt also nie wieder.
  const [einrichtung] = await sql<{ offen: boolean }[]>`
    select not exists (select 1 from settings where key = 'einrichtung')
       and (select value ->> 'name' from settings where key = 'company') = 'Meine Firma GmbH'
       and (select count(*) from users) = 1 as offen`
  if (einrichtung?.offen) redirect('/einrichtung')

  const counts = await badges()
  const sees = (area: Area) => canAccess(user.role, area, user.befugnisse)

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  const firma = company?.name ?? 'ERP'

  // Chamäleon: die Navigation ist eine PROJEKTION der aktiven Prozesse.
  // Klar prozessgebundene Gruppen (Fertigung, Einkauf, Service, Versand)
  // verschwinden, wenn ihr Bereich keinen aktiven Prozess hat — Belege
  // bleiben über Links/URLs erreichbar, nur das Menü passt sich dem
  // Geschäftsmodell an. Grundfunktionen (Lager, Personal, Stammdaten,
  // Auswertungen) bleiben immer.
  const prozessBereiche = new Set(
    (await sql<{ bereich: string }[]>`
      select distinct bereich from prozesse where aktiv`).map((b) => b.bereich),
  )
  const prozessAktiv = (bereich: string) => prozessBereiche.has(bereich)

  const systemzustand =
    counts.fehler > 0
      ? `${counts.fehler} Vorgang/Vorgänge brauchen Aufmerksamkeit`
      : 'Alle Systeme im Normalbetrieb'

  // Befehlsfeld überall (Strg/Cmd+K): derselbe Katalog wie auf der Übersicht,
  // plus das Lern-Gedächtnis dieses Benutzers fürs Ranking.
  const befehle = befehlsKatalog(user.role, prozessAktiv, user.befugnisse)
  const nutzung = await sql<{ schluessel: string; anzahl: number }[]>`
    select schluessel, anzahl from nutzungs_zaehler
    where user_id = ${user.id} order by anzahl desc limit 40`
  const gewichte = Object.fromEntries(nutzung.map((n) => [n.schluessel, Number(n.anzahl)]))

  // Navigation als Datenstruktur: rollengefiltert hier, Aufklapp-Logik im Client.
  const groups: NavGroup[] = [
    {
      label: null,
      items: [
        { href: '/', label: 'Übersicht' },
        // Das Sprechen ist der Kern-Einstieg ins ERP — ganz oben neben der
        // Übersicht, nicht als Randnotiz unter den Auswertungen.
        ...(sees('ki') && sprechenKonfiguriert() ? [{ href: '/sprechen', label: 'Sprechen' }] : []),
        ...(sees('scanner') ? [{ href: '/scanner', label: 'Scanner' }] : []),
      ],
    },
    {
      label: 'Verkauf',
      items: [
        ...(sees('verkauf')
          ? [
              { href: '/verkauf', label: 'Verkaufsaufträge', count: counts.offene_auftraege },
              { href: '/vorgaenge', label: 'Vorgänge' },
            ]
          : []),
        ...(sees('versand') && prozessAktiv('versand')
          ? [{ href: '/versand', label: 'Versand', count: counts.versandbereit }]
          : []),
      ],
    },
    {
      label: 'Fertigung',
      items: sees('fertigung') && prozessAktiv('fertigung')
        ? [
            { href: '/fertigung', label: 'Fertigungsaufträge', count: counts.offene_mos },
            { href: '/fertigung/stuecklisten', label: 'Stücklisten' },
            { href: '/fertigung/arbeitsplaetze', label: 'Arbeitsplätze' },
          ]
        : [],
    },
    {
      label: 'Einkauf',
      items: sees('einkauf') && prozessAktiv('einkauf')
        ? [
            { href: '/einkauf', label: 'Bestellungen' },
            { href: '/einkauf/rechnungen', label: 'Rechnungen' },
            { href: '/einkauf/kurse', label: 'Wechselkurse' },
          ]
        : [],
    },
    {
      label: 'Lager',
      items: sees('lager')
        ? [
            { href: '/lager', label: 'Transfers', count: counts.offene_eingaenge },
            { href: '/lager/zulauf', label: 'Zulauf' },
            { href: '/lager/bestand', label: 'Bestand' },
            { href: '/lager/bewertung', label: 'Bewertung' },
            // Beschaffungsvorschläge münden in Bestellungen oder Fertigungs-
            // aufträge — ohne aktiven Einkaufs- oder Fertigungsprozess wäre
            // der Zähler ein Signal ins Leere (Meldebestände bleiben Daten).
            ...(prozessAktiv('einkauf') || prozessAktiv('fertigung')
              ? [{ href: '/lager/beschaffung', label: 'Beschaffung', count: counts.beschaffung }]
              : []),
            { href: '/lager/lose', label: 'Lose & Serien' },
            { href: '/lager/inventur', label: 'Inventur' },
          ]
        : [],
    },
    {
      label: 'Service',
      items: sees('reparatur') && prozessAktiv('reparatur')
        ? [{ href: '/reparatur', label: 'Reparaturen', count: counts.offene_reparaturen }]
        : [],
    },
    {
      label: 'Personal',
      items: [
        ...(sees('zeiterfassung')
          ? [{ href: '/zeiterfassung', label: 'Zeiterfassung', count: counts.anwesend }]
          : []),
        ...(sees('personal')
          ? [
              { href: '/personal', label: 'Mitarbeiter' },
              { href: '/personal/schichtplan', label: 'Schichtplan' },
              { href: '/personal/abwesenheiten', label: 'Abwesenheiten', count: counts.abwesenheiten },
            ]
          : []),
      ],
    },
    {
      label: 'Auswertungen',
      items: [
        ...(sees('auswertungen')
          ? [
              { href: '/auswertungen', label: 'Mengen & Abverkauf' },
              { href: '/auswertungen/kennzahlen', label: 'Kennzahlen' },
            ]
          : []),
        ...(sees('ki') ? [{ href: '/ki', label: 'KI-Analyse' }] : []),
      ],
    },
    {
      // Chamäleon: erscheint erst mit einem aktiven Finanz-Prozess (0059);
      // in Ausbaustufe 1 zieht der fällige-Zahlungen-Badge die Gruppe hoch,
      // sobald der Bereich freigeschaltet ist.
      label: 'Finanzen',
      items: [
        ...(sees('finanzen')
          ? [
              { href: '/finanzen', label: 'Cashflow', count: counts.faellige_zahlungen },
              { href: '/finanzen/plan', label: 'Umsatzplan' },
              { href: '/finanzen/vertraege', label: 'Verträge', count: counts.kuendigungen },
              { href: '/finanzen/darlehen', label: 'Darlehen' },
              { href: '/finanzen/steuern', label: 'Steuern' },
            ]
          : []),
      ],
    },
    {
      label: 'Stammdaten',
      items: [
        ...(sees('produkte') ? [{ href: '/produkte', label: 'Produkte' }] : []),
        ...(sees('kontakte') ? [{ href: '/kontakte', label: 'Kontakte' }] : []),
      ],
    },
    {
      label: 'System',
      items: [
        ...(sees('integrationen')
          ? [{ href: '/integrationen', label: 'Integrationen', count: counts.fehler }]
          : []),
        ...(sees('einstellungen') ? [{ href: '/prozesse', label: 'Prozesse' }] : []),
        ...(sees('einstellungen') ? [{ href: '/einstellungen', label: 'Einstellungen' }] : []),
        ...(sees('fehler')
          ? [{ href: '/tickets', label: 'Tickets', count: counts.offene_bugs }]
          : []),
      ],
    },
  ].filter((g) => g.items.length > 0)

  return (
    <>
    {/* Boot-Splash: einmal je Sitzung, entfernt sich selbst (splash.tsx). */}
    <Splash />
    <AppShell
      sidebar={
        <>
          <div className="brand">
            <HexcoreMark groesse={22} variante="einfach" />
            <Wortmarke groesse={17} />
          </div>
          <div className="brand-sub">{firma}</div>
          <SidebarNav groups={groups} />

          <div className="spacer" />
          {/* Kein <form action={…}>: dessen Server-Fallback-Attribute lösten
              je nach Hydrations-Timing React-Fehler #418 auf jeder Seite aus
              (Baumvergleich Server-HTML vs. Client, siehe AbmeldenKnopf). */}
          <div style={{ padding: '10px 8px 4px' }}>
            <div className="small muted" style={{ marginBottom: 8, lineHeight: 1.4 }}>
              {user.name}
              <br />
              <span className="mono-label">{ROLE_LABELS[user.role]}</span>
            </div>
            <AbmeldenKnopf action={signOut} />
          </div>
        </>
      }
      topbar={
        <>
          {/* Zustandszeile wie auf einem Typenschild: was gerade anliegt.
              Auf dem Telefon bleibt nur die Leuchte stehen — der Satz steht
              dann im title und wird von Vorlesehilfen weiterhin gelesen. */}
          <div className="mono-label systemzeile" title={systemzustand}>
            <span className={`led ${counts.fehler > 0 ? 'on' : 'ok'}`} />
            <span className="systemtext">{systemzustand}</span>
          </div>
          <div className="actions">
            <BefehlsOverlay
              aktionen={befehle.aktionen}
              seiten={befehle.seiten}
              gewichte={gewichte}
            />
            <ScanBox />
            <ThemeToggle />
          </div>
        </>
      }
    >
      {children}
      {/* Fehler melden von jeder Seite aus — der Reiter am rechten Rand. */}
      {sees('fehler') && <TicketOverlay />}
      {/* Der KI-Chat als zweiter Reiter: offen lassen und weiterarbeiten —
          mit Buddy-Modus (Sprachsitzung), wenn der Sprachdienst da ist. */}
      {sees('ki') && kiConfigured() && <KiOverlay sprechen={sprechenKonfiguriert()} />}
    </AppShell>
    </>
  )
}
