import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

interface Kartonage {
  id: string
  name: string
  variant_id: string
  capacity: number
  max_content_g: number
  kleinpaket: boolean
  sequence: number
  active: boolean
  artikel: string
  sku: string | null
  tare_g: number
  bestand: number
}

async function saveKartonage(formData: FormData) {
  'use server'
  await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const variantId = String(formData.get('variant_id') ?? '')
  const capacity = Number(String(formData.get('capacity') ?? '').replace(',', '.'))
  const maxContent = Math.round(Number(formData.get('max_content_g') ?? 0))
  const kleinpaket = formData.get('kleinpaket') === 'on'
  const sequence = Math.round(Number(formData.get('sequence') ?? 10)) || 10

  if (!name) return actionError('Die Kartonage braucht einen Namen.')
  if (!variantId) return actionError('Bitte den Bestandsartikel wählen — ohne ihn gibt es keinen Verbrauch zu buchen.')
  if (!(capacity > 0)) return actionError('Das Fassungsvermögen muss größer als 0 sein.')
  if (!(maxContent > 0)) return actionError('Das Höchstgewicht muss größer als 0 sein.')

  try {
    if (id) {
      await sql`
        update packagings set
          name = ${name}, variant_id = ${variantId}, capacity = ${capacity},
          max_content_g = ${maxContent}, kleinpaket = ${kleinpaket}, sequence = ${sequence}
        where id = ${id}`
    } else {
      await sql`
        insert into packagings (name, variant_id, capacity, max_content_g, kleinpaket, sequence)
        values (${name}, ${variantId}, ${capacity}, ${maxContent}, ${kleinpaket}, ${sequence})`
    }
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen/kartonagen')
  revalidatePath('/versand')
  return actionInfo('Kartonage gespeichert.')
}

async function toggleKartonage(id: string) {
  'use server'
  await requireAdmin()
  await sql`update packagings set active = not active where id = ${id}`
  revalidatePath('/einstellungen/kartonagen')
  revalidatePath('/versand')
}

async function deleteKartonage(id: string) {
  'use server'
  await requireAdmin()
  try {
    await sql`delete from packagings where id = ${id}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen/kartonagen')
  revalidatePath('/versand')
}

function Formular({
  kartonage,
  artikel,
}: {
  kartonage?: Kartonage
  artikel: { id: string; label: string }[]
}) {
  return (
    <ActionForm action={saveKartonage}>
      {kartonage && <input type="hidden" name="id" value={kartonage.id} />}
      <div className="row">
        <label className="field" style={{ flex: 2 }}>
          <span>Name</span>
          <input name="name" defaultValue={kartonage?.name ?? ''} placeholder="z. B. Kleinpaket-Karton" required />
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span>Bestandsartikel (Karton im Lager)</span>
          <select name="variant_id" defaultValue={kartonage?.variant_id ?? ''} required>
            <option value="">— wählen —</option>
            {artikel.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
        <label className="field shrink">
          <span>Reihenfolge</span>
          <input type="number" name="sequence" defaultValue={kartonage?.sequence ?? 10} style={{ width: 80 }} />
        </label>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field shrink">
          <span>Fassungsvermögen</span>
          <input
            type="number"
            step="0.1"
            min="0.1"
            name="capacity"
            defaultValue={kartonage?.capacity ?? 1}
            style={{ width: 100 }}
          />
        </label>
        <label className="field shrink">
          <span>Höchstgewicht Inhalt (g)</span>
          <input
            type="number"
            name="max_content_g"
            defaultValue={kartonage?.max_content_g ?? 1000}
            style={{ width: 120 }}
          />
        </label>
        <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" name="kleinpaket" defaultChecked={kartonage?.kleinpaket ?? false} />
          <span>darf als Kleinpaket verschickt werden</span>
        </label>
        <div className="muted small field">
          Fassungsvermögen in derselben Skala wie der Platzbedarf am Produkt:
          <strong> 1 = ein volles Kleinpaket</strong> (35,5 × 25 × 8 cm).
        </div>
      </div>
      <button className="primary" type="submit" style={{ marginTop: 10 }}>
        {kartonage ? 'Speichern' : 'Kartonage anlegen'}
      </button>
    </ActionForm>
  )
}

export default async function KartonagenPage() {
  await requireArea('einstellungen')

  const kartonagen = await sql<Kartonage[]>`
    select p.id, p.name, p.variant_id, p.capacity, p.max_content_g, p.kleinpaket,
           p.sequence, p.active,
           pv.display_name as artikel, pv.sku,
           coalesce(pt.weight_g, 0) as tare_g,
           coalesce(on_hand_qty(pv.id, null), 0)::float as bestand
    from packagings p
    join product_variants pv on pv.id = p.variant_id
    join product_templates pt on pt.id = pv.template_id
    order by p.sequence, p.capacity`

  // Kandidaten: alles, was nicht verkauft wird — Verpackung ist Verbrauchs-,
  // keine Handelsware. Bereits verwendete bleiben in der Liste.
  const artikel = await sql<{ id: string; label: string }[]>`
    select pv.id,
           pv.display_name || coalesce(' (' || pv.sku || ')', '') ||
             ' — ' || coalesce(pt.weight_g, 0) || ' g' as label
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and not pt.can_be_sold
    order by pv.display_name
    limit 300`

  return (
    <>
      <PageHeader
        title="Kartonagen"
        subtitle="Verpackung wählen, Gewicht mitrechnen, Verbrauch buchen"
        actions={<Link className="btn" href="/einstellungen">Zurück zu den Einstellungen</Link>}
      />

      <div className="notice info">
        Eine Kartonage ist ein <strong>Produkt mit Zusatzangaben</strong> — Bestand, Einkaufspreis und
        Leergewicht kommen aus dem verknüpften Artikel. Beim Etikettieren wird die kleinste passende
        Kartonage gewählt und ihr Leergewicht auf das Sendungsgewicht gerechnet; beim Warenausgang
        wird ein Stück als Bestandsbewegung verbraucht. Ohne gepflegte Kartonagen bleibt alles wie
        bisher (reines Warengewicht, keine Verbrauchsbuchung).
      </div>

      <Card title={`Kartonagen (${kartonagen.length})`} tight>
        {kartonagen.length === 0 ? (
          <Empty>
            Noch keine Kartonagen. Lege den Karton zuerst als Produkt an (Gewicht = Leergewicht,
            „kann verkauft werden" aus), buche Bestand darauf und verknüpfe ihn hier.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Artikel</th>
                  <th className="num">Fasst</th>
                  <th className="num">max. Inhalt</th>
                  <th className="num">Leergewicht</th>
                  <th className="num">Bestand</th>
                  <th>Kleinpaket</th>
                  <th>Aktiv</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {kartonagen.map((k) => (
                  <tr key={k.id} style={k.active ? undefined : { opacity: 0.55 }}>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer' }}>{k.name}</summary>
                        <div style={{ marginTop: 10 }}>
                          <Formular kartonage={k} artikel={artikel} />
                        </div>
                      </details>
                    </td>
                    <td className="small">
                      {k.artikel} {k.sku && <span className="mono small">{k.sku}</span>}
                    </td>
                    <td className="num mono">{qty(Number(k.capacity))}</td>
                    <td className="num mono nowrap">{k.max_content_g} g</td>
                    <td className="num mono nowrap">{k.tare_g} g</td>
                    <td className="num mono">
                      {/* Leerer Kartonvorrat stoppt sonst erst beim Warenausgang. */}
                      <span className={Number(k.bestand) <= 0 ? 'badge danger' : undefined}>
                        {qty(Number(k.bestand))}
                      </span>
                    </td>
                    <td>
                      <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span className={k.kleinpaket ? 'led ok' : 'led off'} />
                        <span className="mono small">{k.kleinpaket ? 'ja' : 'nein'}</span>
                      </span>
                    </td>
                    <td>
                      <ActionButton className="small" action={toggleKartonage.bind(null, k.id)}>
                        {k.active ? 'aktiv' : 'aus'}
                      </ActionButton>
                    </td>
                    <td className="num">
                      <ActionButton
                        className="small danger"
                        action={deleteKartonage.bind(null, k.id)}
                        confirm={`Kartonage „${k.name}" löschen?`}
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

      <Card title="Neue Kartonage">
        <Formular artikel={artikel} />
      </Card>
    </>
  )
}
