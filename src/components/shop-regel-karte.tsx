import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Card } from '@/components/ui'
import type { ActionResult } from '@/modules/shared/action'
import { qty } from '@/modules/shared/format'

/**
 * Shop-Regeln eines Artikels direkt am Produkt bzw. Material (0142,
 * Entscheidungslog 2026-11-27) — dieselben Felder wie in Verkauf →
 * Shop-Verfügbarkeit → „Teile und Artikel", hier mit ausgeschriebener
 * Erklärung je Schalter. Gespeichert wird über dieselbe Aktion
 * (`verkauf.shop_variante_setzen`).
 */
const MODI = [
  { wert: 'auto', text: 'berechnet' },
  { wert: 'immer', text: 'immer verfügbar' },
  { wert: 'aus', text: 'aus (ausverkauft)' },
] as const

export async function ShopRegelKarte({
  variantId,
  darf,
  action,
}: {
  variantId: string
  /** Schreibrecht im Verkauf — sonst nur Anzeige. */
  darf: boolean
  action: (formData: FormData) => Promise<ActionResult>
}) {
  const [v] = await sql<
    {
      template_id: string
      im_shop: boolean
      mto: boolean
      modus: string | null
      artikel_modus: string
      oos_unter: number | null
      gesperrt: boolean
      nicht_einzeln: boolean
      rueckhalt: number | null
      hoechstmenge: number | null
      frei: number
      tastaturen: number
      soll: number
    }[]
  >`
    select pv.template_id, pv.shopify_variant_id is not null as im_shop, ist_made_to_order(pv.id) as mto,
           pv.shop_modus as modus, pt.shop_modus as artikel_modus, pv.shop_oos_unter as oos_unter,
           pv.shop_zurueckhalten as gesperrt, pv.shop_nicht_einzeln as nicht_einzeln,
           pv.shop_rueckhalt::float as rueckhalt, pv.shop_hoechstmenge as hoechstmenge,
           free_to_use(pv.id)::float as frei,
           (select count(distinct b.template_id)::int
              from bom_lines l
              join boms b on b.id = l.bom_id and b.active
              join product_templates t on t.id = b.template_id and t.active
             where l.component_variant_id = pv.id
               and exists (select 1 from product_variants x
                           where x.template_id = t.id and x.active and x.shopify_variant_id is not null)) as tastaturen,
           shopify_soll_menge(pv.id) as soll
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variantId}`
  if (!v) return null

  // Tastaturen (Made-to-Order) werden je Artikel und Option gesteuert — dort, nicht hier.
  if (v.mto) {
    return (
      <Card title="Shop-Verfügbarkeit">
        <p className="small" style={{ margin: 0 }}>
          Diese Variante wird auf Bestellung gebaut; der Shop bekommt die aus dem Material berechnete Menge
          (jetzt {qty(v.soll)}). Regeln je Artikel und Option:{' '}
          <Link href={`/verkauf/shop-verfuegbarkeit?a=${v.template_id}`}>Shop-Verfügbarkeit</Link>.
        </p>
      </Card>
    )
  }

  const lage = [
    v.im_shop ? `wird im Shop einzeln angeboten (jetzt ${qty(v.soll)})` : 'wird im Shop nicht einzeln angeboten',
    v.tastaturen > 0 ? `steckt in ${qty(v.tastaturen)} Shop-${v.tastaturen === 1 ? 'Tastatur' : 'Tastaturen'}` : 'steckt in keiner Shop-Tastatur',
    `${qty(v.frei)} frei`,
  ].join(' · ')

  return (
    <Card title="Shop-Verfügbarkeit">
      <p className="small muted" style={{ marginTop: 0 }}>Dieser Artikel {lage}.</p>
      <ActionForm action={action}>
        <input type="hidden" name="variant_id" value={variantId} />
        <fieldset disabled={!darf} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
          {v.im_shop && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="hidden" name="nicht_einzeln_feld" value="1" />
              <input type="checkbox" name="nicht_einzeln" defaultChecked={v.nicht_einzeln} style={{ marginTop: 3 }} />
              <span>
                <strong>Nicht einzeln verkaufen</strong>
                <span className="small muted" style={{ display: 'block' }}>
                  Der Artikel wird im Shop nicht einzeln angeboten (Menge 0). Tastaturen, die ihn brauchen, sind nicht
                  betroffen.
                </span>
              </span>
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <input type="hidden" name="zurueckhalten_feld" value="1" />
            <input type="checkbox" name="zurueckhalten" defaultChecked={v.gesperrt} style={{ marginTop: 3 }} />
            <span>
              <strong>Für den Shop sperren</strong>
              <span className="small muted" style={{ display: 'block' }}>
                Der Artikel zählt für den Shop als 0 — auch jede Tastatur, die ihn braucht, ist dann ausverkauft. Die
                Fertigung sieht weiter den echten Bestand.
              </span>
            </span>
          </label>
          <div className="row" style={{ marginBottom: 0 }}>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Ausverkauft unter (Stück)</span>
              <input name="oos_unter" type="number" min={1} defaultValue={v.oos_unter ?? ''} placeholder="keine Schwelle" />
              <span className="small muted">Notreserve: für den Shop zählt nur, was darüber liegt — einzeln und in Tastaturen.</span>
            </label>
            {v.im_shop && (
              <>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Rückhalt für die Fertigung (Stück)</span>
                  <input name="rueckhalt" type="number" min={0} step="1" defaultValue={v.rueckhalt ?? ''} placeholder="kein Rückhalt" />
                  <span className="small muted">So viele Stück bleiben der Fertigung; einzeln verkauft wird nur, was darüber liegt.</span>
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Höchstens im Shop (Stück)</span>
                  <input name="hoechstmenge" type="number" min={0} step="1" defaultValue={v.hoechstmenge ?? ''} placeholder="keine Grenze" />
                  <span className="small muted">Nie mehr gleichzeitig einzeln anbieten.</span>
                </label>
              </>
            )}
          </div>
          {v.im_shop && (
            <label className="field" style={{ marginBottom: 0, maxWidth: 320 }}>
              <span>Einzelverkauf an Shopify</span>
              <Auswahl name="modus" defaultValue={v.modus ?? 'erben'}>
                <option value="erben">wie das Produkt ({MODI.find((m) => m.wert === v.artikel_modus)?.text ?? 'berechnet'})</option>
                {MODI.map((m) => (
                  <option key={m.wert} value={m.wert}>{m.text}</option>
                ))}
              </Auswahl>
            </label>
          )}
          {darf && (
            <div className="actions">
              <button type="submit" className="primary">Shop-Regeln speichern</button>
              <Link className="small" href="/verkauf/shop-verfuegbarkeit?ansicht=artikel">Alle Teile und Artikel</Link>
            </div>
          )}
        </fieldset>
      </ActionForm>
      {!darf && <p className="small muted" style={{ marginBottom: 0 }}>Ändern braucht Schreibrecht im Verkauf.</p>}
    </Card>
  )
}
