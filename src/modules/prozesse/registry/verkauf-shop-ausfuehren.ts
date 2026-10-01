import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Jede Regeländerung wirkt sofort: neu rechnen und melden (im Lesemodus übersprungen). */
async function anstossen(): Promise<void> {
  await sql`select inventar_abgleich_anstossen()`
}

const MODUS_TEXT: Record<string, string> = {
  auto: 'berechnet',
  immer: 'immer verfügbar',
  aus: 'aus (ausverkauft)',
  erben: 'wie der Artikel',
}

export async function shopArtikelSetzen(
  p: { template_id: string; modus?: 'auto' | 'immer' | 'aus'; projekt?: string | null },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [t] = await sql<{ name: string }[]>`
    update product_templates set
      shop_modus = coalesce(${p.modus ?? null}, shop_modus),
      projekt = case when ${p.projekt !== undefined} then ${p.projekt ?? null} else projekt end
    where id = ${p.template_id}
    returning name`
  if (!t) throw new Error('Artikel nicht gefunden')
  const teile = [
    p.modus ? `Shop: ${MODUS_TEXT[p.modus]}` : null,
    p.projekt !== undefined ? `Projekt: ${p.projekt ?? '—'}` : null,
  ].filter(Boolean)
  await sql`select log_event('product_template', ${p.template_id}, 'note', ${teile.join(', ')}, ${ctx.actor})`
  await anstossen()
  return { recordId: p.template_id, text: `${t.name}: ${teile.join(', ')}.` }
}

export async function shopVarianteSetzen(
  p: { variant_id: string; modus?: 'auto' | 'immer' | 'aus' | 'erben'; oos_unter?: number | null; zurueckhalten?: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const modus = p.modus === undefined ? undefined : p.modus === 'erben' ? null : p.modus
  const [v] = await sql<{ name: string; template_id: string }[]>`
    update product_variants set
      shop_modus = case when ${modus !== undefined} then ${modus ?? null} else shop_modus end,
      shop_oos_unter = case when ${p.oos_unter !== undefined} then ${p.oos_unter ?? null}::int else shop_oos_unter end,
      shop_zurueckhalten = coalesce(${p.zurueckhalten ?? null}::boolean, shop_zurueckhalten)
    where id = ${p.variant_id}
    returning display_name as name, template_id`
  if (!v) throw new Error('Variante nicht gefunden')
  const teile = [
    p.modus ? `Shop: ${MODUS_TEXT[p.modus]}` : null,
    p.oos_unter !== undefined ? (p.oos_unter ? `ausverkauft unter ${p.oos_unter}` : 'keine Schwelle') : null,
    p.zurueckhalten !== undefined ? (p.zurueckhalten ? 'zurückgehalten' : 'nicht zurückgehalten') : null,
  ].filter(Boolean)
  await sql`select log_event('product_template', ${v.template_id}, 'note', ${`${v.name}: ${teile.join(', ')}`}, ${ctx.actor})`
  await anstossen()
  return { recordId: p.variant_id, text: `${v.name}: ${teile.join(', ')}.` }
}

export async function shopOptionSetzen(
  p: { template_id: string; ptav_id: string; gesperrt: boolean; alle_farben: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Ziel: der Optionswert dieses Artikels — mit alle_farben auch die gleich
  // benannten Werte (Option + Wert) der übrigen Artikel desselben Projekts.
  const ziele = await sql<{ template_id: string; ptav_id: string; artikel: string; wert: string }[]>`
    with quelle as (
      select pt.projekt, pa.name as option, pav.name as wert
      from product_template_attribute_values ptav
      join product_template_attribute_lines al on al.id = ptav.line_id
      join product_attributes pa on pa.id = al.attribute_id
      join product_attribute_values pav on pav.id = ptav.value_id
      join product_templates pt on pt.id = al.template_id
      where ptav.id = ${p.ptav_id} and al.template_id = ${p.template_id}
    )
    select al.template_id, ptav.id as ptav_id, pt.name as artikel, pav.name as wert
    from quelle q
    join product_templates pt on (pt.id = ${p.template_id}
                                  or (${p.alle_farben} and q.projekt is not null and pt.projekt = q.projekt))
    join product_template_attribute_lines al on al.template_id = pt.id
    join product_attributes pa on pa.id = al.attribute_id and pa.name = q.option
    join product_template_attribute_values ptav on ptav.line_id = al.id
    join product_attribute_values pav on pav.id = ptav.value_id and pav.name = q.wert`
  if (ziele.length === 0) throw new Error('Optionswert gehört nicht zu diesem Artikel')
  for (const z of ziele) {
    if (p.gesperrt) {
      await sql`insert into shop_option_sperren (template_id, ptav_id, von) values (${z.template_id}, ${z.ptav_id}, ${ctx.actor})
                on conflict do nothing`
    } else {
      await sql`delete from shop_option_sperren where template_id = ${z.template_id} and ptav_id = ${z.ptav_id}`
    }
    await sql`select log_event('product_template', ${z.template_id}, 'note',
      ${`Shop-Option ${z.wert}: ${p.gesperrt ? 'gesperrt' : 'freigegeben'}`}, ${ctx.actor})`
  }
  await anstossen()
  return {
    recordId: p.template_id,
    text: `${ziele[0].wert} ${p.gesperrt ? 'gesperrt' : 'freigegeben'} in ${ziele.length} Artikel(n).`,
  }
}

export async function shopStandHolen(): Promise<AktionsErgebnis> {
  const { shopStandHolen: holen } = await import('../../integrationen/inventar.ts')
  const r = await holen()
  return {
    text:
      `Shop-Stand gelesen: ${r.varianten} Variante(n), davon ${r.verkaufbar} verkaufbar, ${r.zugeordnet} in KRNL zugeordnet` +
      `${r.zweitangebote ? `, ${r.zweitangebote} Zweitangebot(e) mit derselben SKU (bekommen denselben Bestand)` : ''}.`,
    daten: { ...r },
  }
}

/**
 * Zweitangebot steuern (0106): eigene Steuerung je weiterem Shop-Angebot
 * derselben SKU — z. B. „Black Week Editions" aus, während der Artikel
 * normal weiterläuft.
 */
export async function shopZweitangebotSetzen(
  p: { angebot_id: string; modus: 'auto' | 'immer' | 'aus' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [z] = await sql<{ produkt: string | null; artikel: string; template_id: string }[]>`
    update shopify_zweitangebote z set shop_modus = ${p.modus}
    from product_variants pv
    where z.id = ${p.angebot_id} and pv.id = z.variant_id
    returning z.produkt, pv.display_name as artikel, pv.template_id`
  if (!z) throw new Error('Zweitangebot nicht gefunden')
  const text = `Zweitangebot „${z.produkt ?? 'ohne Titel'}" (${z.artikel}): ${ZWEIT_TEXT[p.modus]}`
  await sql`select log_event('product_template', ${z.template_id}, 'note', ${text}, ${ctx.actor})`
  await anstossen()
  return { recordId: p.angebot_id, text: `${text}.` }
}

const ZWEIT_TEXT: Record<string, string> = {
  auto: 'wie der Artikel',
  immer: 'immer verfügbar',
  aus: 'aus (ausverkauft)',
}
