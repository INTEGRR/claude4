import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'
import { plural } from '@/modules/shared/format'

/**
 * Jede Regeländerung wirkt sofort: neu rechnen und melden (im Lesemodus
 * übersprungen). Mit `variantIds` zuerst der Schnellstopp (feste Menge,
 * Entscheidungslog 2026-11-28): was durch diese Änderung auf 0 muss — der
 * Artikel selbst und alle Angebote, die ihn in der Stückliste haben —,
 * geht sofort, nicht erst mit dem vollen Abgleich.
 */
async function anstossen(variantIds: string[] = []): Promise<void> {
  if (variantIds.length > 0) {
    const { schnellStoppLeise } = await import('@/modules/integrationen/inventar')
    await schnellStoppLeise(variantIds)
  }
  await sql`select inventar_abgleich_anstossen()`
}

/** Die Shop-Varianten dieser Artikel — für den Schnellstopp nach einer Artikel-Regel. */
async function shopVarianten(templateIds: string[]): Promise<string[]> {
  if (templateIds.length === 0) return []
  const rows = await sql<{ id: string }[]>`
    select id from product_variants
    where template_id = any(${templateIds}::uuid[]) and active and shopify_variant_id is not null`
  return rows.map((r) => r.id)
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
  await anstossen(await shopVarianten([p.template_id]))
  return { recordId: p.template_id, text: `${t.name}: ${teile.join(', ')}.` }
}

/**
 * Verkauf starten oder stoppen — mehrere Artikel auf einmal (2026-11-27):
 * vor dem Release stehen die neuen Tastaturen auf „aus" (Shopify bekommt 0),
 * zum Start stellt EIN Knopf alle auf „berechnet"; ein Abgleich für alle.
 */
export async function shopVerkaufSchalten(
  p: { template_ids: string[]; start: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const modus = p.start ? 'auto' : 'aus'
  const artikel = await sql<{ id: string; name: string }[]>`
    update product_templates set shop_modus = ${modus}
    where id = any(${p.template_ids}::uuid[]) and active
    returning id, name`
  if (artikel.length === 0) throw new Error('Keine Artikel gefunden')
  for (const a of artikel) {
    await sql`select log_event('product_template', ${a.id}, 'note',
      ${p.start ? 'Shop: Verkauf gestartet (berechnet)' : 'Shop: Verkauf gestoppt (aus)'}, ${ctx.actor})`
  }
  await anstossen(await shopVarianten(artikel.map((a) => a.id)))
  const { shopifyModus } = await import('../../integrationen/shopify-modus.ts')
  const shop = await shopifyModus(sql)
  const hinweis =
    shop === 'schreiben'
      ? p.start ? ' Die verteilten Mengen gehen jetzt an Shopify.' : ' Shopify bekommt jetzt 0.'
      : ` Achtung: Shopify steht auf „${shop === 'probe' ? 'Probelauf' : 'nur lesen'}" — an den Shop geht nichts hinaus.`
  return {
    text:
      `Verkauf ${p.start ? 'gestartet' : 'gestoppt'}: ${plural(artikel.length, 'Artikel', 'Artikel')} ` +
      `auf „${MODUS_TEXT[modus]}".${hinweis}`,
    daten: { artikel: artikel.length, modus, shopify: shop },
  }
}

export async function shopVarianteSetzen(
  p: {
    variant_id: string
    modus?: 'auto' | 'immer' | 'aus' | 'erben'
    oos_unter?: number | null
    zurueckhalten?: boolean
    nicht_einzeln?: boolean
    rueckhalt?: number | null
    hoechstmenge?: number | null
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const modus = p.modus === undefined ? undefined : p.modus === 'erben' ? null : p.modus
  const [v] = await sql<{ name: string; template_id: string }[]>`
    update product_variants set
      shop_modus = case when ${modus !== undefined} then ${modus ?? null} else shop_modus end,
      shop_oos_unter = case when ${p.oos_unter !== undefined} then ${p.oos_unter ?? null}::int else shop_oos_unter end,
      shop_zurueckhalten = coalesce(${p.zurueckhalten ?? null}::boolean, shop_zurueckhalten),
      shop_nicht_einzeln = coalesce(${p.nicht_einzeln ?? null}::boolean, shop_nicht_einzeln),
      shop_rueckhalt = case when ${p.rueckhalt !== undefined} then ${p.rueckhalt || null}::numeric else shop_rueckhalt end,
      shop_hoechstmenge = case when ${p.hoechstmenge !== undefined} then ${p.hoechstmenge ?? null}::int else shop_hoechstmenge end
    where id = ${p.variant_id}
    returning display_name as name, template_id`
  if (!v) throw new Error('Variante nicht gefunden')
  const teile = [
    p.modus ? `Shop: ${MODUS_TEXT[p.modus]}` : null,
    p.oos_unter !== undefined ? (p.oos_unter ? `ausverkauft unter ${p.oos_unter}` : 'keine Schwelle') : null,
    p.zurueckhalten !== undefined ? (p.zurueckhalten ? 'für den Shop gesperrt (auch in Tastaturen)' : 'nicht gesperrt') : null,
    p.nicht_einzeln !== undefined ? (p.nicht_einzeln ? 'nicht einzeln verkaufen' : 'einzeln verkaufbar') : null,
    p.rueckhalt !== undefined ? (p.rueckhalt ? `Rückhalt für die Fertigung ${p.rueckhalt}` : 'kein Rückhalt') : null,
    p.hoechstmenge !== undefined
      ? p.hoechstmenge !== null ? `höchstens ${p.hoechstmenge} im Einzelverkauf` : 'keine Höchstmenge'
      : null,
  ].filter(Boolean)
  await sql`select log_event('product_template', ${v.template_id}, 'note', ${`${v.name}: ${teile.join(', ')}`}, ${ctx.actor})`
  await anstossen([p.variant_id])
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
  await anstossen(await shopVarianten([...new Set(ziele.map((z) => z.template_id))]))
  return {
    recordId: p.template_id,
    text: `${ziele[0].wert} ${p.gesperrt ? 'gesperrt' : 'freigegeben'} in ${plural(ziele.length, 'Artikel', 'Artikeln')}.`,
  }
}

export async function shopStandHolen(): Promise<AktionsErgebnis> {
  const { shopStandHolen: holen } = await import('../../integrationen/inventar.ts')
  const r = await holen()
  return {
    text:
      `Shop-Stand gelesen: ${plural(r.varianten, 'Variante', 'Varianten')}, davon ${r.verkaufbar} verkaufbar, ${r.zugeordnet} in KRNL zugeordnet` +
      `${r.zweitangebote ? `, ${plural(r.zweitangebote, 'Zweitangebot', 'Zweitangebote')} mit derselben SKU (bekommen denselben Bestand)` : ''}.`,
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

/**
 * Not-Aus (S6, 0136): alle Angebote sofort auf ausverkauft — absolut gesetzt,
 * unabhängig vom Buch — bzw. wieder freigeben. Wirkt sofort (der Abgleich
 * läuft im selben Zug), nicht erst mit dem nächsten Job.
 */
export async function shopNotAus(p: { aktiv: boolean }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const stand = { aktiv: p.aktiv, seit: new Date().toISOString(), von: ctx.actor }
  await sql`
    insert into settings (key, value) values ('shopify', ${sql.json({ not_aus: stand })})
    on conflict (key) do update set value = settings.value || ${sql.json({ not_aus: stand })}::jsonb`
  const { einreihen } = await import('../../integrationen/benachrichtigungen.ts')
  await einreihen(sql, 'ueberverkauf', `not-aus:${stand.seit}`,
    p.aktiv
      ? `🛑 <b>Not-Aus</b> für den Shop ausgelöst von ${ctx.actor}: alle Angebote stehen auf ausverkauft.`
      : `✅ Not-Aus aufgehoben von ${ctx.actor}: die Kontingente werden neu verteilt.`)

  // Sofort melden. Läuft gerade ein Abgleich, sieht er den Anstoß und rechnet eine weitere Runde.
  await anstossen()
  let gemeldet: string
  try {
    const { inventarAbgleichen } = await import('../../integrationen/inventar.ts')
    const r = await inventarAbgleichen()
    gemeldet = r.gesperrt
      ? 'Ein Abgleich läuft gerade — er übernimmt den Not-Aus in der nächsten Runde (Sekunden).'
      : `${plural(r.uebertragen + r.angeboteUebertragen, 'Angebot', 'Angebote')} gemeldet.`
  } catch (err) {
    gemeldet = `Meldung an den Shop gescheitert (${err instanceof Error ? err.message : String(err)}) — der Abgleich versucht es weiter.`
  }
  return {
    text: p.aktiv
      ? `Not-Aus aktiv: alle Angebote auf ausverkauft. ${gemeldet}`
      : `Not-Aus aufgehoben: die Kontingente werden neu verteilt. ${gemeldet}`,
  }
}

/**
 * Erwartete Nachfrage (0136): Gewicht eines Artikels oder Optionswerts für
 * die Verteilung knapper Teile. Wirkt beim nächsten Abgleich.
 */
export async function shopGewichtSetzen(
  p: { template_id: string; ptav_id?: string; gewicht: number | null; alle_farben: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  if (!p.ptav_id) {
    const [pt] = await sql<{ name: string }[]>`
      update product_templates set shop_gewicht = ${p.gewicht} where id = ${p.template_id} returning name`
    if (!pt) throw new Error('Artikel nicht gefunden')
    await sql`select log_event('product_template', ${p.template_id}, 'note',
      ${`Shop-Gewicht des Artikels: ${p.gewicht ?? 1}`}, ${ctx.actor})`
    await anstossen()
    return { recordId: p.template_id, text: `Gewicht von „${pt.name}": ${p.gewicht ?? 1}.` }
  }
  // Wie beim Sperren: mit alle_farben auch die gleich benannten Werte der
  // übrigen Artikel desselben Projekts.
  const ziele = await sql<{ template_id: string; ptav_id: string; wert: string }[]>`
    with quelle as (
      select pt.projekt, pa.name as option, pav.name as wert
      from product_template_attribute_values ptav
      join product_template_attribute_lines al on al.id = ptav.line_id
      join product_attributes pa on pa.id = al.attribute_id
      join product_attribute_values pav on pav.id = ptav.value_id
      join product_templates pt on pt.id = al.template_id
      where ptav.id = ${p.ptav_id} and al.template_id = ${p.template_id}
    )
    select al.template_id, ptav.id as ptav_id, pav.name as wert
    from quelle q
    join product_templates pt on (pt.id = ${p.template_id}
                                  or (${p.alle_farben} and q.projekt is not null and pt.projekt = q.projekt))
    join product_template_attribute_lines al on al.template_id = pt.id
    join product_attributes pa on pa.id = al.attribute_id and pa.name = q.option
    join product_template_attribute_values ptav on ptav.line_id = al.id
    join product_attribute_values pav on pav.id = ptav.value_id and pav.name = q.wert`
  if (ziele.length === 0) throw new Error('Optionswert gehört nicht zu diesem Artikel')
  await sql`update product_template_attribute_values set shop_gewicht = ${p.gewicht}
            where id = any(${ziele.map((z) => z.ptav_id)}::uuid[])`
  for (const z of ziele) {
    await sql`select log_event('product_template', ${z.template_id}, 'note',
      ${`Shop-Gewicht ${z.wert}: ${p.gewicht ?? 1}`}, ${ctx.actor})`
  }
  await anstossen()
  return {
    recordId: p.template_id,
    text: `Gewicht von ${ziele[0].wert}: ${p.gewicht ?? 1} in ${plural(ziele.length, 'Artikel', 'Artikeln')}.`,
  }
}
