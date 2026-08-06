import { redirect } from 'next/navigation'
import { currentUser, logout } from '@/modules/auth'
import { type Area, ROLE_LABELS, canAccess } from '@/modules/auth/permissions'
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
      ((select count(*) from integration_jobs where status = 'failed')
       + (select count(*) from shopify_unmatched_lines where resolved_at is null))::int as fehler`
  return row
}

export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  const counts = await badges()
  const sees = (area: Area) => canAccess(user.role, area)

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">ERP</div>
        <NavLink href="/">Übersicht</NavLink>
        {sees('scanner') && <NavLink href="/scanner">Scanner</NavLink>}

        {(sees('verkauf') || sees('versand')) && <div className="group">Verkauf</div>}
        {sees('verkauf') && (
          <NavLink href="/verkauf" count={counts.offene_auftraege}>Verkaufsaufträge</NavLink>
        )}
        {sees('versand') && <NavLink href="/versand" count={counts.versandbereit}>Versand</NavLink>}

        {sees('fertigung') && (
          <>
            <div className="group">Fertigung</div>
            <NavLink href="/fertigung" count={counts.offene_mos}>Fertigungsaufträge</NavLink>
            <NavLink href="/fertigung/stuecklisten">Stücklisten</NavLink>
          </>
        )}

        {sees('einkauf') && (
          <>
            <div className="group">Einkauf</div>
            <NavLink href="/einkauf" >Bestellungen</NavLink>
            <NavLink href="/einkauf/rechnungen">Rechnungen</NavLink>
          </>
        )}

        {sees('lager') && (
          <>
            <div className="group">Lager</div>
            <NavLink href="/lager" count={counts.offene_eingaenge}>Transfers</NavLink>
            <NavLink href="/lager/bestand">Bestand</NavLink>
            <NavLink href="/lager/inventur">Inventur</NavLink>
          </>
        )}

        {sees('reparatur') && (
          <>
            <div className="group">Service</div>
            <NavLink href="/reparatur" count={counts.offene_reparaturen}>Reparaturen</NavLink>
          </>
        )}

        {(sees('auswertungen') || sees('ki')) && <div className="group">Auswertungen</div>}
        {sees('auswertungen') && <NavLink href="/auswertungen">Auswertungen</NavLink>}
        {sees('ki') && <NavLink href="/ki">KI-Analyse</NavLink>}

        {(sees('produkte') || sees('kontakte')) && <div className="group">Stammdaten</div>}
        {sees('produkte') && <NavLink href="/produkte">Produkte</NavLink>}
        {sees('kontakte') && <NavLink href="/kontakte">Kontakte</NavLink>}

        {(sees('integrationen') || sees('einstellungen')) && <div className="group">System</div>}
        {sees('integrationen') && (
          <NavLink href="/integrationen" count={counts.fehler}>Integrationen</NavLink>
        )}
        {sees('einstellungen') && <NavLink href="/einstellungen">Einstellungen</NavLink>}

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
