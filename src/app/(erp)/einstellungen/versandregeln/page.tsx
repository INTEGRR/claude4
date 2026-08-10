import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { KLEINPAKET } from '@/modules/versand/regeln-logik'

export const dynamic = 'force-dynamic'

const PRODUKTE = [
  ['V01PAK', 'DHL Paket (national)'],
  ['V62KP', 'DHL Kleinpaket (35,5 × 25 × 8 cm, 1 kg)'],
  ['V54EPAK', 'DHL Europaket (EU)'],
  ['V53WPAK', 'DHL Paket International'],
  ['V66WPI', 'DHL Kleinpaket international'],
] as const

const ZONEN = [
  ['de', 'Deutschland'],
  ['eu', 'EU (Zollunion)'],
  ['world', 'Welt (zollpflichtig)'],
] as const

interface Regel {
  id: string
  sequence: number
  name: string
  active: boolean
  min_weight_g: number | null
  max_weight_g: number | null
  zone: string | null
  skus: string[] | null
  sku_scope: string
  require_kleinpaket_fit: boolean
  dhl_product: string | null
  billing_number: string | null
  insurance_from_value: number | null
}

function formWerte(formData: FormData) {
  const zahl = (name: string): number | null => {
    const raw = String(formData.get(name) ?? '').trim().replace(',', '.')
    return raw === '' ? null : Number(raw)
  }
  const skus = String(formData.get('skus') ?? '')
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    name: String(formData.get('name') ?? '').trim(),
    sequence: zahl('sequence') ?? 10,
    minWeight: zahl('min_weight_g'),
    maxWeight: zahl('max_weight_g'),
    zone: String(formData.get('zone') ?? '') || null,
    skus: skus.length ? skus : null,
    skuScope: String(formData.get('sku_scope') ?? 'any'),
    kleinpaketFit: formData.get('require_kleinpaket_fit') === 'on',
    product: String(formData.get('dhl_product') ?? '') || null,
    billing: String(formData.get('billing_number') ?? '').trim() || null,
    insuranceFrom: zahl('insurance_from_value'),
  }
}

async function saveRule(formData: FormData) {
  'use server'
  await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const w = formWerte(formData)
  if (!w.name) return actionError('Die Regel braucht einen Namen.')
  if (!w.product && !w.billing && w.insuranceFrom === null) {
    return actionError('Die Regel braucht mindestens eine Aktion (Produkt, Abrechnungsnummer oder Versicherung).')
  }
  try {
    if (id) {
      await sql`
        update shipping_rules set
          name = ${w.name}, sequence = ${w.sequence},
          min_weight_g = ${w.minWeight}, max_weight_g = ${w.maxWeight},
          zone = ${w.zone}, skus = ${w.skus}, sku_scope = ${w.skuScope},
          require_kleinpaket_fit = ${w.kleinpaketFit},
          dhl_product = ${w.product}, billing_number = ${w.billing},
          insurance_from_value = ${w.insuranceFrom}
        where id = ${id}`
    } else {
      await sql`
        insert into shipping_rules
          (name, sequence, min_weight_g, max_weight_g, zone, skus, sku_scope,
           require_kleinpaket_fit, dhl_product, billing_number, insurance_from_value)
        values
          (${w.name}, ${w.sequence}, ${w.minWeight}, ${w.maxWeight}, ${w.zone},
           ${w.skus}, ${w.skuScope}, ${w.kleinpaketFit}, ${w.product},
           ${w.billing}, ${w.insuranceFrom})`
    }
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen/versandregeln')
  revalidatePath('/versand')
  return actionInfo('Regel gespeichert.')
}

async function toggleRule(id: string) {
  'use server'
  await requireAdmin()
  await sql`update shipping_rules set active = not active where id = ${id}`
  revalidatePath('/einstellungen/versandregeln')
  revalidatePath('/versand')
}

async function deleteRule(id: string) {
  'use server'
  await requireAdmin()
  await sql`delete from shipping_rules where id = ${id}`
  revalidatePath('/einstellungen/versandregeln')
  revalidatePath('/versand')
}

/** Tauscht die Reihenfolge mit dem Nachbarn — Regeln werden von oben nach unten ausgewertet. */
async function moveRule(id: string, richtung: 'hoch' | 'runter') {
  'use server'
  await requireAdmin()
  const regeln = await sql<{ id: string; sequence: number }[]>`
    select id, sequence from shipping_rules order by sequence, name`
  const index = regeln.findIndex((r) => r.id === id)
  const nachbar = richtung === 'hoch' ? index - 1 : index + 1
  if (index < 0 || nachbar < 0 || nachbar >= regeln.length) return
  // Gleiche sequence-Werte machen den Tausch wirkungslos — dann neu durchnummerieren.
  if (regeln[index].sequence === regeln[nachbar].sequence) {
    for (const [i, r] of regeln.entries()) {
      await sql`update shipping_rules set sequence = ${(i + 1) * 10} where id = ${r.id}`
    }
    return moveRule(id, richtung)
  }
  await sql`update shipping_rules set sequence = ${regeln[nachbar].sequence} where id = ${regeln[index].id}`
  await sql`update shipping_rules set sequence = ${regeln[index].sequence} where id = ${regeln[nachbar].id}`
  revalidatePath('/einstellungen/versandregeln')
  revalidatePath('/versand')
}

function RegelFormular({ regel }: { regel?: Regel }) {
  return (
    <ActionForm action={saveRule}>
      {regel && <input type="hidden" name="id" value={regel.id} />}
      <div className="row">
        <label className="field" style={{ flex: 2 }}>
          <span>Name</span>
          <input name="name" defaultValue={regel?.name ?? ''} required />
        </label>
        <label className="field shrink">
          <span>Reihenfolge</span>
          <input type="number" name="sequence" defaultValue={regel?.sequence ?? 10} style={{ width: 80 }} />
        </label>
      </div>
      <fieldset style={{ border: 'none', padding: 0, margin: '8px 0 0' }}>
        <div className="mono-label" style={{ marginBottom: 6 }}>Wenn (leer = wird nicht geprüft)</div>
        <div className="row">
          <label className="field shrink">
            <span>Gewicht ab (g)</span>
            <input type="number" name="min_weight_g" defaultValue={regel?.min_weight_g ?? ''} style={{ width: 100 }} />
          </label>
          <label className="field shrink">
            <span>Gewicht bis (g)</span>
            <input type="number" name="max_weight_g" defaultValue={regel?.max_weight_g ?? ''} style={{ width: 100 }} />
          </label>
          <label className="field shrink">
            <span>Zone</span>
            <select name="zone" defaultValue={regel?.zone ?? ''}>
              <option value="">alle</option>
              {ZONEN.map(([wert, text]) => (
                <option key={wert} value={wert}>{text}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 2 }}>
            <span>SKU-Muster (Komma-getrennt, * erlaubt)</span>
            <input className="mono" name="skus" defaultValue={regel?.skus?.join(', ') ?? ''} placeholder="KC-*, KAB-*" />
          </label>
          <label className="field shrink">
            <span>SKU-Treffer</span>
            <select name="sku_scope" defaultValue={regel?.sku_scope ?? 'any'}>
              <option value="any">eine Position genügt</option>
              <option value="all">alle Positionen</option>
            </select>
          </label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <input
            type="checkbox"
            name="require_kleinpaket_fit"
            defaultChecked={regel?.require_kleinpaket_fit ?? false}
          />
          <span>
            nur wenn die Ware ins Kleinpaket passt (Produkt-Flag; {KLEINPAKET.maxLengthMm / 10} ×{' '}
            {KLEINPAKET.maxWidthMm / 10} × {KLEINPAKET.maxHeightMm / 10} cm, bis {KLEINPAKET.maxWeightG} g)
          </span>
        </label>
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '10px 0 0' }}>
        <div className="mono-label" style={{ marginBottom: 6 }}>Dann</div>
        <div className="row">
          <label className="field">
            <span>DHL-Produkt</span>
            <select name="dhl_product" className="mono" defaultValue={regel?.dhl_product ?? ''}>
              <option value="">— nicht setzen —</option>
              {PRODUKTE.map(([code, text]) => (
                <option key={code} value={code}>{code} — {text}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Abrechnungsnummer (leer = automatisch zum Produkt)</span>
            <input className="mono" name="billing_number" defaultValue={regel?.billing_number ?? ''} maxLength={14} />
          </label>
          <label className="field shrink">
            <span>Versicherung ab Warenwert (€)</span>
            <input type="number" step="0.01" name="insurance_from_value"
              defaultValue={regel?.insurance_from_value ?? ''} style={{ width: 130 }} />
          </label>
        </div>
      </fieldset>
      <button className="primary" type="submit" style={{ marginTop: 10 }}>
        {regel ? 'Speichern' : 'Regel anlegen'}
      </button>
    </ActionForm>
  )
}

function bedingungen(r: Regel): string {
  const teile: string[] = []
  if (r.min_weight_g != null) teile.push(`ab ${r.min_weight_g} g`)
  if (r.max_weight_g != null) teile.push(`bis ${r.max_weight_g} g`)
  if (r.zone) teile.push(ZONEN.find(([w]) => w === r.zone)?.[1] ?? r.zone)
  if (r.skus?.length) teile.push(`SKU ${r.skus.join('|')}${r.sku_scope === 'all' ? ' (alle)' : ''}`)
  if (r.require_kleinpaket_fit) teile.push('passt ins Kleinpaket')
  return teile.length ? teile.join(' · ') : 'immer'
}

function aktionen(r: Regel): string {
  const teile: string[] = []
  if (r.dhl_product) teile.push(r.dhl_product)
  if (r.billing_number) teile.push(`Abr.-Nr. ${r.billing_number}`)
  if (r.insurance_from_value != null) teile.push(`Versicherung ab ${r.insurance_from_value} €`)
  return teile.join(' · ')
}

export default async function VersandregelnPage() {
  await requireArea('einstellungen')
  const regeln = await sql<Regel[]>`
    select id, sequence, name, active, min_weight_g, max_weight_g, zone, skus,
           sku_scope, require_kleinpaket_fit, dhl_product, billing_number,
           insurance_from_value
    from shipping_rules order by sequence, name`

  return (
    <>
      <PageHeader
        title="Versandregeln"
        subtitle="Von oben nach unten ausgewertet — je Aktion gewinnt die erste passende Regel"
        actions={<Link className="btn" href="/einstellungen">Zurück zu den Einstellungen</Link>}
      />

      <div className="notice info">
        Die Regeln bestimmen den <strong>Vorschlag</strong> am Packtisch (DHL-Produkt, Abrechnungsnummer,
        Versicherung) und den Massendruck — überschreiben bleibt immer möglich. „Passt ins Kleinpaket"
        prüft das Flag am Produkt: Summe (Menge ÷ „Stück je Kleinpaket") über alle Positionen ≤ 1.
      </div>

      <Card title={`Regeln (${regeln.length})`} tight>
        {regeln.length === 0 ? (
          <Empty>Keine Regeln — ohne Regeln gilt die Länder-Automatik (DE Paket, EU Europaket, sonst International).</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Reihenfolge</th>
                  <th>Name</th>
                  <th>Wenn</th>
                  <th>Dann</th>
                  <th>Aktiv</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {regeln.map((r, index) => (
                  <tr key={r.id} style={r.active ? undefined : { opacity: 0.55 }}>
                    <td className="mono">
                      <span className="actions nowrap" style={{ gap: 4 }}>
                        {r.sequence}
                        <ActionButton className="small" action={moveRule.bind(null, r.id, 'hoch')} disabled={index === 0}>↑</ActionButton>
                        <ActionButton className="small" action={moveRule.bind(null, r.id, 'runter')} disabled={index === regeln.length - 1}>↓</ActionButton>
                      </span>
                    </td>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer' }}>{r.name}</summary>
                        <div style={{ marginTop: 10 }}>
                          <RegelFormular regel={r} />
                        </div>
                      </details>
                    </td>
                    <td className="small">{bedingungen(r)}</td>
                    <td className="small mono">{aktionen(r)}</td>
                    <td>
                      <ActionButton className="small" action={toggleRule.bind(null, r.id)}>
                        {r.active ? 'aktiv' : 'aus'}
                      </ActionButton>
                    </td>
                    <td className="num">
                      <ActionButton
                        className="small danger"
                        action={deleteRule.bind(null, r.id)}
                        confirm={`Regel „${r.name}" löschen?`}
                      >
                        Löschen
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Neue Regel">
        <RegelFormular />
      </Card>
    </>
  )
}
