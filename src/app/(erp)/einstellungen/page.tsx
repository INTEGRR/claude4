import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, PageHeader, TableWrap } from '@/components/ui'

export const dynamic = 'force-dynamic'

interface Company {
  [key: string]: string | undefined
  name: string
  street: string
  house: string
  zip: string
  city: string
  country: string
  email?: string
  phone?: string
}

async function saveCompany(formData: FormData) {
  'use server'
  await requireAdmin()
  const value: Company = {
    name: String(formData.get('name') ?? ''),
    street: String(formData.get('street') ?? ''),
    house: String(formData.get('house') ?? ''),
    zip: String(formData.get('zip') ?? ''),
    city: String(formData.get('city') ?? ''),
    country: String(formData.get('country') ?? 'DEU'),
    email: String(formData.get('email') ?? ''),
    phone: String(formData.get('phone') ?? ''),
  }
  await sql`update settings set value = ${sql.json(value)} where key = 'company'`
  revalidatePath('/einstellungen')
}

async function saveDhl(formData: FormData) {
  'use server'
  await requireAdmin()
  const value = {
    default_product: String(formData.get('default_product') ?? 'V01PAK'),
    print_format: String(formData.get('print_format') ?? '910-300-700'),
  }
  await sql`update settings set value = ${sql.json(value)} where key = 'dhl'`
  revalidatePath('/einstellungen')
}

async function savePolicies(formData: FormData) {
  'use server'
  await requireAdmin()
  await sql`update settings set value = ${sql.json({
    lock_confirmed: formData.get('sales_lock') === 'on',
  })} where key = 'sales'`
  await sql`update settings set value = ${sql.json({
    lock_confirmed: formData.get('purchase_lock') === 'on',
  })} where key = 'purchase'`
  revalidatePath('/einstellungen')
}

/**
 * Gespeicherter Zustand einer Belegregel — Leuchte plus Wort, nicht nur der
 * Haken. Zeigt den zuletzt gespeicherten Stand, nicht die Vorwahl im Formular.
 */
function Zustand({ an }: { an: boolean }) {
  return (
    <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={an ? 'led ok' : 'led off'} />
      {an ? 'gesperrt' : 'offen'}
    </span>
  )
}

export default async function EinstellungenPage() {
  await requireArea('einstellungen')
  const settings = await sql<{ key: string; value: Record<string, unknown> }[]>`
    select key, value from settings`
  const get = <T,>(key: string): T => (settings.find((s) => s.key === key)?.value ?? {}) as T

  const company = get<Company>('company')
  const dhl = get<{ default_product?: string; print_format?: string }>('dhl')
  const sales = get<{ lock_confirmed?: boolean }>('sales')
  const purchase = get<{ lock_confirmed?: boolean }>('purchase')

  const sequences = await sql<{ code: string; prefix: string; next_number: number }[]>`
    select code, prefix, next_number from sequences order by code`

  return (
    <>
      <PageHeader
        title="Einstellungen"
        subtitle="Firmendaten, Versand und Belegverhalten"
        actions={<Link className="btn" href="/einstellungen/benutzer">Benutzer verwalten</Link>}
      />

      <Card title="Firmendaten (Absender für DHL-Labels und Belege)">
        <ActionForm action={saveCompany}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Firmenname</span>
              <input name="name" defaultValue={company.name} required />
            </label>
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" defaultValue={company.email ?? ''} />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" defaultValue={company.phone ?? ''} />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" defaultValue={company.street} required />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house" defaultValue={company.house} required />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input name="zip" defaultValue={company.zip} required />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" defaultValue={company.city} required />
            </label>
            <label className="field">
              <span>Land (ISO alpha-3)</span>
              <input className="mono" name="country" defaultValue={company.country} maxLength={3} required />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
      </Card>

      <Card title="Versand (DHL)">
        <ActionForm action={saveDhl}>
          <div className="row">
            <label className="field">
              <span>Standard-Produkt</span>
              <select name="default_product" defaultValue={dhl.default_product ?? 'V01PAK'}>
                <option value="V01PAK">V01PAK — DHL Paket national</option>
                <option value="V54EPAK">V54EPAK — Europaket</option>
                <option value="V53WPAK">V53WPAK — Paket International</option>
              </select>
            </label>
            <label className="field">
              <span>Label-Format</span>
              <select name="print_format" defaultValue={dhl.print_format ?? '910-300-700'}>
                <option value="910-300-700">910-300-700 (105 × 208 mm)</option>
                <option value="910-300-600">910-300-600 (Thermo 103 × 199)</option>
                <option value="910-300-400">910-300-400 (Thermo 103 × 150)</option>
                <option value="A4">A4</option>
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <div className="notice info" style={{ marginBottom: 0 }}>
          Zugangsdaten (API-Key, GKP-Benutzer, Abrechnungsnummer) werden aus Sicherheitsgründen als
          Umgebungsvariablen gesetzt, nicht hier. Hinweis: Das Passwort des GKP-Systembenutzers läuft
          nach 365 Tagen ab.
        </div>
      </Card>

      <Card title="Belegverhalten">
        <ActionForm action={savePolicies}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" name="sales_lock" defaultChecked={sales.lock_confirmed ?? false} />
              <span>Verkaufsaufträge beim Bestätigen automatisch sperren</span>
              <Zustand an={sales.lock_confirmed ?? false} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" name="purchase_lock" defaultChecked={purchase.lock_confirmed ?? false} />
              <span>Bestellungen beim Bestätigen automatisch sperren</span>
              <Zustand an={purchase.lock_confirmed ?? false} />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
      </Card>

      <Card title="Nummernkreise" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Beleg</th>
                <th>Präfix</th>
                <th className="num">Nächste Nummer</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((s) => (
                <tr key={s.code}>
                  <td className="mono small">{s.code}</td>
                  <td className="mono">{s.prefix}</td>
                  <td className="num mono">{s.next_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  )
}
