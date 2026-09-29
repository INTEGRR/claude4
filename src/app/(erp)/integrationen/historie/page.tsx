import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { HistorieBestellung } from '@/modules/integrationen/shopify-csv'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { money, qty } from '@/modules/shared/format'
import { HistorieImport } from './historie-import'

export const dynamic = 'force-dynamic'

async function pruefen(skus: string[], namen: string[]) {
  'use server'
  return serverAktion('integrationen.historie_pruefen', { parameter: { skus, namen } })
}

async function importieren(bestellungen: HistorieBestellung[]) {
  'use server'
  return serverAktion('integrationen.historie_importieren', { parameter: { bestellungen } })
}

async function preiseNachziehen() {
  'use server'
  return serverAktion('integrationen.shopify_preise_nachziehen', {})
}

/**
 * Verkaufshistorie aus dem Shopify-Export (0089). Die API liefert ohne den
 * geschützten Scope read_all_orders nur 60 Tage — der CSV-Export des
 * Shop-Admins kennt diese Grenze nicht.
 */
export default async function HistoriePage() {
  const user = await requireArea('integrationen')
  const [stand] = await sql<
    { anzahl: number; von: string | null; bis: string | null; offen_netto: number }[]
  >`
    select count(*) filter (where historisch)::int as anzahl,
           min(order_date) filter (where historisch)::text as von,
           max(order_date) filter (where historisch)::text as bis,
           count(*) filter (where source = 'shopify' and shopify_order_id is not null
                              and not (zusatz ? 'netto_0089')
                              and not (historisch and number = shopify_order_name))::int as offen_netto
    from sales_orders`
  const jahre = await sql<{ jahr: string; auftraege: number; umsatz: number }[]>`
    select to_char(so.order_date, 'YYYY') as jahr, count(distinct so.id)::int as auftraege,
           coalesce(sum(l.qty * l.price_unit * (1 - l.discount / 100.0)), 0) as umsatz
    from sales_orders so
    left join sales_order_lines l on l.order_id = so.id and l.variant_id is not null
    where so.source = 'shopify' and so.state = 'sale'
    group by 1 order by 1 desc`
  const admin = user.role === 'admin'

  return (
    <>
      <PageHeader
        title="Historie aus Shopify"
        subtitle="Vergangene Bestellungen aus dem Shopify-Export übernehmen — für Verkaufszahlen und Auswertungen der Vorjahre"
        actions={<Link className="btn" href="/integrationen">Zu den Integrationen</Link>}
      />

      <div className="notice info">
        Shopify gibt per Schnittstelle nur die Bestellungen der <strong>letzten 60 Tage</strong> heraus
        (ohne den geschützten Zugriff „read_all_orders"). Die ältere Historie kommt deshalb aus dem
        Export: <strong>Shopify-Admin → Bestellungen → Exportieren → „Alle Bestellungen", CSV</strong>{' '}
        (große Exporte schickt Shopify per Mail). Übernommen wird nur als Historie — keine Lieferung,
        keine Reservierung, keine Fertigung. Preise netto nach Rabatt, Versand getrennt.
      </div>

      <Card title="Export hochladen">
        {admin ? (
          <HistorieImport pruefen={pruefen} importieren={importieren} />
        ) : (
          <p className="small muted">Nur Administratoren können die Historie übernehmen.</p>
        )}
      </Card>

      <Card title="Stand">
        <p className="small" style={{ marginTop: 0 }}>
          {qty(stand.anzahl)} historische Aufträge
          {stand.von ? ` von ${stand.von.slice(0, 10)} bis ${stand.bis?.slice(0, 10)}` : ''}.
        </p>
        {jahre.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Jahr</th>
                <th className="num">Shopify-Aufträge</th>
                <th className="num">Warenumsatz netto</th>
              </tr>
            </thead>
            <tbody>
              {jahre.map((j) => (
                <tr key={j.jahr}>
                  <td className="mono">{j.jahr}</td>
                  <td className="num mono">{qty(j.auftraege)}</td>
                  <td className="num mono">{money(j.umsatz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {shopifyConfigured() && admin && (
        <Card title="Preise bereits importierter Aufträge">
          <p className="small" style={{ marginTop: 0 }}>
            Bis zu dieser Version stand an per Schnittstelle importierten Aufträgen der
            Brutto-Listenpreis vor Rabatt. Der Knopf holt sie lesend neu aus Shopify und setzt Netto-Preise,
            Steuersatz und Versandkosten — je Klick bis zu 30 Aufträge.{' '}
            {stand.offen_netto > 0 ? (
              <strong>{qty(stand.offen_netto)} offen.</strong>
            ) : (
              'Alle erledigt.'
            )}
          </p>
          {stand.offen_netto > 0 && (
            <ActionButton action={preiseNachziehen}>Preise netto nachziehen</ActionButton>
          )}
        </Card>
      )}
    </>
  )
}
