import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { RETOURE_GRUENDE } from '@/modules/versand/retoure-gruende'
import { retoureAnlegen } from '../actions'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Retoure von Hand anlegen (0119) — wenn der Kunde schreibt oder anruft statt
 * das Portal zu nutzen. Gesucht wird der Shop-Auftrag (Shop-Bestellnummer
 * oder KRNL-Nummer), angeboten wird je Position, was geliefert und noch in
 * keiner Retoure steckt.
 */
export default async function RetoureNeuPage({ searchParams }: { searchParams: Promise<{ auftrag?: string; suche?: string }> }) {
  await requireArea('versand')
  const { auftrag, suche } = await searchParams

  let auftragId: string | null = auftrag && UUID.test(auftrag) ? auftrag : null
  if (!auftragId && suche?.trim()) {
    const roh = suche.trim()
    const [treffer] = await sql<{ id: string }[]>`
      select id from sales_orders
      where source = 'shopify' and (number = ${roh} or shopify_order_name = ${roh} or shopify_order_name = ${`#${roh.replace(/^#/, '')}`})
      order by order_date desc limit 1`
    auftragId = treffer?.id ?? null
  }

  const [kopf] = auftragId
    ? await sql<{ id: string; number: string; bestellung: string | null; kunde: string; source: string; email: string | null }[]>`
        select so.id, so.number, so.shopify_order_name as bestellung, coalesce(so.ship_name, p.name) as kunde,
               so.source::text as source, coalesce(so.ship_email, p.email) as email
        from sales_orders so join partners p on p.id = so.partner_id where so.id = ${auftragId}`
    : []

  const zeilen = kopf
    ? await sql<{ id: string; name: string; geliefert: number; schon: number }[]>`
        select sol.id, sol.name, sol.qty_delivered as geliefert,
               coalesce((select sum(rp.menge) from retoure_positionen rp join retouren r on r.id = rp.retoure_id
                         where rp.sales_order_line_id = sol.id and r.status not in ('abgelehnt', 'storniert')), 0) as schon
        from sales_order_lines sol
        where sol.order_id = ${kopf.id} and sol.variant_id is not null and sol.qty_delivered > 0
        order by sol.sequence`
    : []

  return (
    <>
      <PageHeader
        title="Retoure anlegen"
        subtitle="Für Kunden, die schreiben oder anrufen — im Shop gibt es dafür das Retourenportal"
        actions={<Link className="btn" href="/versand/retouren">Alle Retouren</Link>}
      />

      <Card title="Auftrag">
        <form method="get" className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            <span>Shop-Bestellnummer oder Auftragsnummer</span>
            <input name="suche" defaultValue={kopf?.bestellung ?? suche ?? ''} placeholder="#1042" required />
          </label>
          <div className="shrink field">
            <button type="submit">Suchen</button>
          </div>
        </form>
        {suche && !kopf && <p className="small muted">Kein Shop-Auftrag zu „{suche}" gefunden.</p>}
      </Card>

      {kopf && (
        <Card
          title={`Positionen · ${kopf.bestellung ?? kopf.number} · ${kopf.kunde}`}
          tight
        >
          {kopf.source !== 'shopify' ? (
            <Empty>Retouren gibt es nur für Shop-Aufträge.</Empty>
          ) : zeilen.length === 0 ? (
            <Empty>Zu diesem Auftrag ist noch nichts geliefert.</Empty>
          ) : (
            <ActionForm action={retoureAnlegen.bind(null, kopf.id)}>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th className="num">Geliefert</th>
                      <th className="num">Schon in Retouren</th>
                      <th className="num">Zurück</th>
                      <th>Grund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zeilen.map((z) => {
                      const frei = Math.max(Number(z.geliefert) - Number(z.schon), 0)
                      return (
                        <tr key={z.id}>
                          <td>{z.name}</td>
                          <td className="num">{qty(z.geliefert)}</td>
                          <td className="num">{Number(z.schon) > 0 ? qty(z.schon) : '—'}</td>
                          <td className="num">
                            <input
                              name={`menge_${z.id}`}
                              type="number"
                              min="0"
                              max={frei}
                              step="1"
                              defaultValue={zeilen.length === 1 && frei > 0 ? frei : ''}
                              disabled={frei <= 0}
                              style={{ width: 80 }}
                            />
                          </td>
                          <td>
                            <Auswahl name={`grund_${z.id}`} defaultValue="" disabled={frei <= 0}>
                              <option value="">—</option>
                              {RETOURE_GRUENDE.map((g) => (
                                <option key={g} value={g}>{g}</option>
                              ))}
                            </Auswahl>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <div className="row" style={{ padding: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="field" style={{ flex: 3 }}>
                  <span>Anliegen des Kunden</span>
                  <input name="grund" placeholder="z. B. passt nicht zum Setup, Mail vom 12.10." />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  <span>Antwortadresse (sonst {kopf.email ?? 'keine bekannt'})</span>
                  <input name="email" type="email" />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Retoure anlegen</button>
                </div>
              </div>
            </ActionForm>
          )}
        </Card>
      )}
    </>
  )
}
