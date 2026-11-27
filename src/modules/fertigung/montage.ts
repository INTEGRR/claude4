import { sql } from '@/db/client'
import {
  type MontageEinstellung,
  type MontageKnoten,
  type MontageZeile,
  MONTAGE_STANDARD,
  montageBaum,
  montageBuendel,
} from './montage-logik.ts'

/**
 * Montage-Übersicht (0141): liest die offenen Fertigungsaufträge und baut
 * daraus den Baum. Wahrheit ist der Belegstatus — gezählt wird, was in
 * bestätigten oder laufenden Aufträgen noch nicht fertig gemeldet ist.
 */
export interface MontageStand {
  stand: string
  gesamt: number
  /** Heute fertig gemeldet (Stück), Ortszeit Berlin. */
  fertigHeute: number
  /** Offene Fertigungsaufträge, die in die Zahl eingehen. */
  auftraege: number
  knoten: MontageKnoten[]
  buendel: { schluessel: string; pfad: string[]; offen: number }[]
  einstellung: MontageEinstellung
  /** Alle Attributnamen der offenen Aufträge — Vorschlag für die Einstellung. */
  attributeBekannt: string[]
}

export async function montageEinstellung(): Promise<MontageEinstellung> {
  const [row] = await sql<{ value: { name_teile?: unknown; attribute?: unknown } | null }[]>`
    select value from settings where key = 'montage'`
  const liste = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
  if (!row?.value) return MONTAGE_STANDARD
  return { nameTeile: liste(row.value.name_teile), attribute: liste(row.value.attribute) }
}

export async function montageStand(): Promise<MontageStand> {
  const [einstellung, zeilen, [kopf]] = await Promise.all([
    montageEinstellung(),
    sql<{ produkt: string; werte: Record<string, string> | null; offen: number }[]>`
      select pt.name as produkt,
             (select jsonb_object_agg(a.name, av.name)
                from product_variant_attribute_values pvav
                join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
                join product_template_attribute_lines al on al.id = ptav.line_id
                join product_attributes a on a.id = al.attribute_id
                join product_attribute_values av on av.id = ptav.value_id
               where pvav.variant_id = pv.id) as werte,
             sum(greatest(mo.qty_to_produce - mo.qty_produced, 0))::float as offen
      from manufacturing_orders mo
      join product_variants pv on pv.id = mo.variant_id
      join product_templates pt on pt.id = pv.template_id
      where mo.state in ('confirmed', 'progress')
      group by pt.name, pv.id
      having sum(greatest(mo.qty_to_produce - mo.qty_produced, 0)) > 0`,
    sql<{ auftraege: number; fertig_heute: number }[]>`
      select (select count(*)::int from manufacturing_orders
               where state in ('confirmed', 'progress') and qty_to_produce > qty_produced) as auftraege,
             (select coalesce(sum(qty_produced), 0)::float from manufacturing_orders
               where state = 'done'
                 and (date_done at time zone 'Europe/Berlin')::date = (now() at time zone 'Europe/Berlin')::date) as fertig_heute`,
  ])
  const daten: MontageZeile[] = zeilen.map((z) => ({ produkt: z.produkt, werte: z.werte ?? {}, offen: Number(z.offen) }))
  const { gesamt, knoten } = montageBaum(daten, einstellung)
  return {
    stand: new Date().toISOString(),
    gesamt,
    fertigHeute: Number(kopf?.fertig_heute ?? 0),
    auftraege: kopf?.auftraege ?? 0,
    knoten,
    buendel: montageBuendel(knoten),
    einstellung,
    attributeBekannt: [...new Set(daten.flatMap((z) => Object.keys(z.werte)))].sort((a, b) => a.localeCompare(b, 'de')),
  }
}
