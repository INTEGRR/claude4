import { redirect } from 'next/navigation'
import { currentUser, logout } from '@/modules/auth'
import { type Area, ROLE_LABELS, canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { type NavGroup, SidebarNav } from '@/components/sidebar-nav'
import { ScanBox } from '@/components/scan-box'

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
      fehler: number
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
      ((select count(*) from integration_jobs where status = 'failed')
       + (select count(*) from shopify_unmatched_lines where resolved_at is null))::int as fehler`
  return row
}

export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  const counts = await badges()
  const sees = (area: Area) => canAccess(user.role, area)

  // Navigation als Datenstruktur: rollengefiltert hier, Aufklapp-Logik im Client.
  const groups: NavGroup[] = [
    {
      label: null,
      items: [
        { href: '/', label: 'Übersicht' },
        ...(sees('scanner') ? [{ href: '/scanner', label: 'Scanner' }] : []),
      ],
    },
    {
      label: 'Verkauf',
      items: [
        ...(sees('verkauf')
          ? [{ href: '/verkauf', label: 'Verkaufsaufträge', count: counts.offene_auftraege }]
          : []),
        ...(sees('versand')
          ? [{ href: '/versand', label: 'Versand', count: counts.versandbereit }]
          : []),
      ],
    },
    {
      label: 'Fertigung',
      items: sees('fertigung')
        ? [
            { href: '/fertigung', label: 'Fertigungsaufträge', count: counts.offene_mos },
            { href: '/fertigung/stuecklisten', label: 'Stücklisten' },
          ]
        : [],
    },
    {
      label: 'Einkauf',
      items: sees('einkauf')
        ? [
            { href: '/einkauf', label: 'Bestellungen' },
            { href: '/einkauf/rechnungen', label: 'Rechnungen' },
          ]
        : [],
    },
    {
      label: 'Lager',
      items: sees('lager')
        ? [
            { href: '/lager', label: 'Transfers', count: counts.offene_eingaenge },
            { href: '/lager/bestand', label: 'Bestand' },
            { href: '/lager/beschaffung', label: 'Beschaffung', count: counts.beschaffung },
            { href: '/lager/inventur', label: 'Inventur' },
          ]
        : [],
    },
    {
      label: 'Service',
      items: sees('reparatur')
        ? [{ href: '/reparatur', label: 'Reparaturen', count: counts.offene_reparaturen }]
        : [],
    },
    {
      label: 'Auswertungen',
      items: [
        ...(sees('auswertungen') ? [{ href: '/auswertungen', label: 'Auswertungen' }] : []),
        ...(sees('ki') ? [{ href: '/ki', label: 'KI-Analyse' }] : []),
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
        ...(sees('einstellungen') ? [{ href: '/einstellungen', label: 'Einstellungen' }] : []),
      ],
    },
  ].filter((g) => g.items.length > 0)

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">ERP</div>
        <SidebarNav groups={groups} />

        <div className="spacer" />
        <form action={signOut} style={{ padding: '8px 10px' }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {user.name}
            <br />
            <span style={{ opacity: 0.7 }}>{ROLE_LABELS[user.role]}</span>
          </div>
          <button className="small" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
            Abmelden
          </button>
        </form>
      </nav>

      <div className="main">
        <div className="topbar">
          <div />
          <ScanBox />
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
