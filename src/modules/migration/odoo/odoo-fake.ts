/**
 * Odoo-Attrappe (ODOO_FAKE=1) für Prozesstests und Staging: ein kleiner
 * Datenbestand im Rohformat der JSON-RPC-Antworten (many2one = [id, Name],
 * many2many = Liste von IDs). Die Szene deckt ab, was die
 * Stücklisten-Übernahme können muss:
 *
 *   - NATIVE 75 (Farbe Weiß/Schwarz × Layout ISO-DE/ANSI) mit einer
 *     Vorlagen-Stückliste, deren Zeilen per Filter nur für bestimmte
 *     Varianten gelten; Routen Fertigen + Auf Auftrag.
 *   - Switch-Tester mit Stückliste für 2 Stück (wird auf 1 normiert).
 *   - Komponenten mit und ohne SKU, eine in Dutzend, eine in kg.
 *   - Ein Lieferant mit Preis, Bestände an internen Lagerorten — auch von
 *     Artikeln ohne Stückliste (Deskmat) und vom Fertigprodukt Switch-Tester.
 *
 * Unterstützt search_read/read mit einfachen Domänen (=, in); unbekannte
 * Methoden gibt es nicht — odooLesen weist sie vorher ab.
 */

type Datensatz = Record<string, unknown> & { id: number }

const m2o = (id: number, name: string) => [id, name]

const VARIANTE = (
  id: number,
  tmpl: [number, string],
  code: string | false,
  name: string,
  ptavs: number[] = [],
  extra: Partial<Datensatz> = {},
): Datensatz => ({
  id,
  product_tmpl_id: tmpl,
  default_code: code,
  barcode: false,
  display_name: name,
  product_template_attribute_value_ids: ptavs,
  standard_price: 0,
  weight: 0,
  active: true,
  uom_id: m2o(1, 'Units'),
  ...extra,
})

const T_KB: [number, string] = [100, 'NATIVE 75']
const T_ST: [number, string] = [200, 'Switch-Tester']
const T_TEIL: [number, string] = [300, 'Teile']
const T_ZUB: [number, string] = [400, 'Deskmat']

export const ODOO_FAKE_DATEN: Record<string, Datensatz[]> = {
  'uom.uom': [
    { id: 1, name: 'Units', factor: 1, category_id: m2o(1, 'Unit') },
    { id: 2, name: 'Dozens', factor: 1 / 12, category_id: m2o(1, 'Unit') },
    { id: 3, name: 'kg', factor: 1, category_id: m2o(2, 'Weight') },
    { id: 4, name: 'g', factor: 1000, category_id: m2o(2, 'Weight') },
  ],
  'product.template': [
    { id: 100, name: 'NATIVE 75', uom_id: m2o(1, 'Units'), route_ids: [1, 2] },
    { id: 200, name: 'Switch-Tester', uom_id: m2o(1, 'Units'), route_ids: [1] },
    { id: 300, name: 'Teile', uom_id: m2o(1, 'Units'), route_ids: [3] },
  ],
  'stock.route': [
    { id: 1, name: 'Manufacture', rule_ids: [11] },
    { id: 2, name: 'Replenish on Order (MTO)', rule_ids: [12] },
    { id: 3, name: 'Buy', rule_ids: [13] },
  ],
  'stock.rule': [
    { id: 11, route_id: m2o(1, 'Manufacture'), action: 'manufacture', procure_method: 'make_to_stock' },
    { id: 12, route_id: m2o(2, 'MTO'), action: 'pull', procure_method: 'make_to_order' },
    { id: 13, route_id: m2o(3, 'Buy'), action: 'buy', procure_method: 'make_to_stock' },
  ],
  'product.template.attribute.value': [
    { id: 11, attribute_id: m2o(1, 'Farbe'), name: 'Weiß' },
    { id: 12, attribute_id: m2o(1, 'Farbe'), name: 'Schwarz' },
    { id: 21, attribute_id: m2o(2, 'Layout'), name: 'ISO-DE' },
    { id: 22, attribute_id: m2o(2, 'Layout'), name: 'ANSI' },
  ],
  'product.product': [
    VARIANTE(1, T_KB, 'FAKE-KB-W-DE', 'NATIVE 75 (Weiß, ISO-DE)', [11, 21]),
    VARIANTE(2, T_KB, 'FAKE-KB-W-US', 'NATIVE 75 (Weiß, ANSI)', [11, 22]),
    VARIANTE(3, T_KB, 'FAKE-KB-B-DE', 'NATIVE 75 (Schwarz, ISO-DE)', [12, 21]),
    VARIANTE(4, T_KB, 'FAKE-KB-B-US', 'NATIVE 75 (Schwarz, ANSI)', [12, 22]),
    VARIANTE(5, T_ST, 'FAKE-ST-1', 'Switch-Tester'),
    VARIANTE(10, T_TEIL, 'FAKE-GH-W', 'Gehäuse Weiß', [], { standard_price: 20, weight: 0.4 }),
    VARIANTE(11, T_TEIL, 'FAKE-GH-B', 'Gehäuse Schwarz', [], { standard_price: 20, weight: 0.4 }),
    VARIANTE(12, T_TEIL, 'FAKE-PL-1', 'Platine', [], { standard_price: 30 }),
    VARIANTE(13, T_TEIL, 'FAKE-KC-DE', 'Keycaps ISO-DE', [], { standard_price: 12 }),
    VARIANTE(14, T_TEIL, 'FAKE-KC-US', 'Keycaps ANSI', [], { standard_price: 12 }),
    VARIANTE(15, T_TEIL, 'FAKE-SW-1', 'Switch linear', [], { standard_price: 0.25 }),
    VARIANTE(16, T_TEIL, false, 'Schrauben M2', [], { uom_id: m2o(2, 'Dozens') }),
    VARIANTE(17, T_TEIL, 'FAKE-KLEBER', 'Kleber', [], { uom_id: m2o(4, 'g') }),
    VARIANTE(20, T_ZUB, 'FAKE-DM-1', 'Deskmat', [], { standard_price: 6 }),
    VARIANTE(21, T_ZUB, 'FAKE-DM-X', 'Deskmat Sonderedition'),
  ],
  'mrp.bom': [
    { id: 1000, product_tmpl_id: T_KB, product_id: false, product_qty: 1, product_uom_id: m2o(1, 'Units'), type: 'normal', sequence: 1, consumption: 'flexible' },
    { id: 2000, product_tmpl_id: T_ST, product_id: false, product_qty: 2, product_uom_id: m2o(1, 'Units'), type: 'normal', sequence: 1, consumption: 'strict' },
  ],
  'mrp.bom.line': [
    { id: 1, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(10, 'Gehäuse Weiß'), product_qty: 1, product_uom_id: m2o(1, 'Units'), sequence: 1, bom_product_template_attribute_value_ids: [11] },
    { id: 2, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(11, 'Gehäuse Schwarz'), product_qty: 1, product_uom_id: m2o(1, 'Units'), sequence: 2, bom_product_template_attribute_value_ids: [12] },
    { id: 3, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(12, 'Platine'), product_qty: 1, product_uom_id: m2o(1, 'Units'), sequence: 3, bom_product_template_attribute_value_ids: [] },
    { id: 4, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(13, 'Keycaps ISO-DE'), product_qty: 1, product_uom_id: m2o(1, 'Units'), sequence: 4, bom_product_template_attribute_value_ids: [21] },
    { id: 5, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(14, 'Keycaps ANSI'), product_qty: 1, product_uom_id: m2o(1, 'Units'), sequence: 5, bom_product_template_attribute_value_ids: [22] },
    { id: 6, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(15, 'Switch linear'), product_qty: 70, product_uom_id: m2o(1, 'Units'), sequence: 6, bom_product_template_attribute_value_ids: [] },
    { id: 7, bom_id: m2o(1000, 'NATIVE 75'), product_id: m2o(16, 'Schrauben M2'), product_qty: 1, product_uom_id: m2o(2, 'Dozens'), sequence: 7, bom_product_template_attribute_value_ids: [] },
    { id: 8, bom_id: m2o(2000, 'Switch-Tester'), product_id: m2o(15, 'Switch linear'), product_qty: 18, product_uom_id: m2o(1, 'Units'), sequence: 1, bom_product_template_attribute_value_ids: [] },
    { id: 9, bom_id: m2o(2000, 'Switch-Tester'), product_id: m2o(17, 'Kleber'), product_qty: 0.01, product_uom_id: m2o(3, 'kg'), sequence: 2, bom_product_template_attribute_value_ids: [] },
  ],
  'product.supplierinfo': [
    { id: 1, partner_id: m2o(7, 'Gateron (Fake)'), product_tmpl_id: T_TEIL, product_id: m2o(15, 'Switch linear'), price: 0.22, min_qty: 1000, delay: 30, currency_id: m2o(1, 'EUR'), product_code: 'G-SW-LIN' },
  ],
  'res.partner': [{ id: 7, name: 'Gateron (Fake)', email: 'sales@gateron.example' }],
  'stock.quant': [
    { id: 1, product_id: m2o(15, 'Switch linear'), quantity: 5000, location_id: m2o(8, 'WH/Stock'), location_usage: 'internal' },
    { id: 2, product_id: m2o(13, 'Keycaps ISO-DE'), quantity: 40, location_id: m2o(8, 'WH/Stock'), location_usage: 'internal' },
    { id: 3, product_id: m2o(15, 'Switch linear'), quantity: 999, location_id: m2o(5, 'Partners/Vendors'), location_usage: 'supplier' },
    { id: 4, product_id: m2o(5, 'Switch-Tester'), quantity: 12, location_id: m2o(8, 'WH/Stock'), location_usage: 'internal' },
    { id: 5, product_id: m2o(20, 'Deskmat'), quantity: 300, location_id: m2o(8, 'WH/Stock'), location_usage: 'internal' },
    { id: 6, product_id: m2o(20, 'Deskmat'), quantity: 75, location_id: m2o(9, 'WH/Stock/Regal'), location_usage: 'internal' },
    { id: 7, product_id: m2o(21, 'Deskmat Sonderedition'), quantity: 4, location_id: m2o(8, 'WH/Stock'), location_usage: 'internal' },
  ],
}

function wertVon(d: Datensatz, feld: string): unknown {
  if (feld === 'location_id.usage') return d.location_usage
  // Wie in Odoo: ohne active-Feld ist ein Datensatz immer aktiv.
  if (feld === 'active' && d.active === undefined) return true
  const v = d[feld]
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string' ? v[0] : v
}

function passt(d: Datensatz, domain: unknown[]): boolean {
  return domain.every((bedingung) => {
    if (!Array.isArray(bedingung)) return true
    const [feld, op, wert] = bedingung as [string, string, unknown]
    const ist = wertVon(d, feld)
    if (op === '=') return ist === wert
    if (op === 'in') {
      const liste = wert as unknown[]
      return Array.isArray(ist) ? ist.some((x) => liste.includes(x)) : liste.includes(ist)
    }
    return true
  })
}

export function fakeOdoo(
  modell: string,
  methode: string,
  args: unknown[],
  kwargs: Record<string, unknown>,
): unknown {
  const alle = ODOO_FAKE_DATEN[modell] ?? []
  if (methode === 'search_read') {
    const domain = (args[0] as unknown[]) ?? []
    const offset = Number(kwargs.offset ?? 0)
    const limit = Number(kwargs.limit ?? alle.length)
    return alle.filter((d) => passt(d, domain)).slice(offset, offset + limit)
  }
  if (methode === 'read') {
    const ids = args[0] as number[]
    return alle.filter((d) => ids.includes(d.id))
  }
  if (methode === 'search_count') return alle.filter((d) => passt(d, (args[0] as unknown[]) ?? [])).length
  return {}
}
