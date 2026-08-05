import { sql } from '@/db/client'
import { Card, PageHeader } from '@/components/ui'
import { createOrder } from '../actions'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage() {
  const partners = await sql<{ id: string; name: string; city: string | null }[]>`
    select id, name, city from partners where is_customer and active order by name limit 500`

  return (
    <>
      <PageHeader title="Neuer Verkaufsauftrag" subtitle="Kunde wählen, Positionen folgen im nächsten Schritt" />
      <Card>
        <form action={createOrder} style={{ maxWidth: 460 }}>
          <label className="field">
            <span>Kunde</span>
            <select name="partner_id" required defaultValue="">
              <option value="" disabled>— auswählen —</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.city ? ` · ${p.city}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" type="submit">Auftrag anlegen</button>
        </form>
        {partners.length === 0 && (
          <div className="notice warn" style={{ marginTop: 12 }}>
            Es sind noch keine Kunden angelegt. Lege zuerst unter <strong>Kontakte</strong> einen an.
          </div>
        )}
      </Card>
    </>
  )
}
