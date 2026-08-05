import { redirect } from 'next/navigation'
import { currentUser, logout } from '@/modules/auth'
import { sql } from '@/db/client'
import { NavLink } from '@/components/nav-link'
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
      fehler: number
    }[]
  >`
    select
      (select count(*) from sales_orders where state = 'sale' and delivery_status <> 'full')::int,
      (select count(*) from manufacturing_orders where state not in ('done','cancel'))::int,
      (select count(*) from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
        where ot.kind = 'receipt' and p.state not in ('done','cancel'))::int,
      (select count(*) from shipping_ready)::int,
      (select count(*) from repair_orders where state not in ('repaired','cancel'))::int,
      (select count(*) from integration_jobs where status = 'failed')::int
        + (select count(*) from shopify_unmatched_lines where resolved_at is null)::int`
  return row
}

export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  const counts = await badges()

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">ERP</div>
        <NavLink href="/">Übersicht</NavLink>

        <div className="group">Verkauf</div>
        <NavLink href="/verkauf" count={counts.offene_auftraege}>Verkaufsaufträge</NavLink>
        <NavLink href="/versand" count={counts.versandbereit}>Versand</NavLink>

        <div className="group">Fertigung</div>
        <NavLink href="/fertigung" count={counts.offene_mos}>Fertigungsaufträge</NavLink>
        <NavLink href="/fertigung/stuecklisten">Stücklisten</NavLink>

        <div className="group">Einkauf</div>
        <NavLink href="/einkauf" >Bestellungen</NavLink>
        <NavLink href="/einkauf/rechnungen">Rechnungen</NavLink>

        <div className="group">Lager</div>
        <NavLink href="/lager" count={counts.offene_eingaenge}>Transfers</NavLink>
        <NavLink href="/lager/bestand">Bestand</NavLink>
        <NavLink href="/lager/inventur">Inventur</NavLink>

        <div className="group">Service</div>
        <NavLink href="/reparatur" count={counts.offene_reparaturen}>Reparaturen</NavLink>

        <div className="group">Stammdaten</div>
        <NavLink href="/produkte">Produkte</NavLink>
        <NavLink href="/kontakte">Kontakte</NavLink>

        <div className="group">System</div>
        <NavLink href="/integrationen" count={counts.fehler}>Integrationen</NavLink>
        <NavLink href="/einstellungen">Einstellungen</NavLink>

        <div className="spacer" />
        <form action={signOut} style={{ padding: '8px 10px' }}>
          <div className="small muted" style={{ marginBottom: 6 }}>{user.name}</div>
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
