import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import { createOrder, createOrderForNewCustomer } from '../actions'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage() {
  await requireArea('verkauf')
  const partners = await sql<{ id: string; name: string; city: string | null }[]>`
    select id, name, city from partners where is_customer and active order by name limit 500`

  return (
    <>
      <PageHeader title="Neuer Verkaufsauftrag" subtitle="Kunde wählen, Positionen folgen im nächsten Schritt" />
      <Card>
        <ActionForm action={createOrder} style={{ maxWidth: 460 }}>
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
        </ActionForm>
        {partners.length === 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            Noch keine Kunden angelegt — dafür ist die zweite Karte da.
          </div>
        )}
      </Card>

      {/* BUG/00012: Am Telefon ist der Kunde oft neu. Ihn erst unter Kontakte
          anzulegen und dann hierher zurückzukommen ist ein Umweg, den niemand
          geht — beides läuft jetzt in einer Aktion. */}
      <Card title="… oder neuer Kunde">
        <ActionForm action={createOrderForNewCustomer}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Firmenname</span>
              <input name="name" placeholder="nur bei Firmen" />
            </label>
            <label className="field">
              <span>Vorname</span>
              <input name="vorname" placeholder="bei Personen" />
            </label>
            <label className="field">
              <span>Nachname</span>
              <input name="nachname" placeholder="bei Personen" />
            </label>
            <label className="shrink field" style={{ alignSelf: 'end' }}>
              <input type="checkbox" name="is_company" /> Firma
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house_number" placeholder="für DHL nötig" />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input className="mono" name="zip" />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" />
            </label>
            <label className="field">
              <span>Land</span>
              <input className="mono" name="country_code" defaultValue="DE" maxLength={2} />
            </label>
          </div>
          <button className="primary" type="submit">Kunde anlegen &amp; Auftrag starten</button>
        </ActionForm>
      </Card>
    </>
  )
}
