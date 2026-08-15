import type { ISql } from 'postgres'

/**
 * Produktanlage samt Attributen und Variantenmatrix.
 *
 * Bewusst ohne App-Abhängigkeiten und mit der Verbindung als Parameter (wie
 * sql-tool.ts): so läuft dieselbe Funktion, die die KI-Aktion ausführt, im
 * Test in einer zurückgerollten Transaktion.
 *
 * Angelegt wird ausschließlich über die Wege der Oberfläche — insbesondere
 * generate_variants, das die Matrix bildet. Kein Sonderweg für die KI.
 */

export interface ProduktAttribut {
  name: string
  werte: { name: string; aufpreis?: number; kuerzel?: string; farbe?: string }[]
}

export interface ProduktEingabe {
  name: string
  verkaufspreis?: number
  einstandspreis?: number
  gewicht_g?: number
  verkaufbar?: boolean
  einkaufbar?: boolean
  route?: 'kaufen' | 'fertigen'
  sku?: string
  beschreibung?: string
  attribute?: ProduktAttribut[]
}

export interface ProduktErgebnis {
  templateId: string
  varianten: number
  benannt: number
}

/**
 * `ISql` ist die gemeinsame Basis von Verbindung und Transaktion: die
 * Anwendung reicht ihren Client herein, der Test seine zurückgerollte
 * Transaktion.
 */
export async function produktAnlegen(
  db: ISql,
  p: ProduktEingabe,
  actor: string,
): Promise<ProduktErgebnis> {
  const [uom] = await db<{ id: string }[]>`select id from uoms where name = 'Stück' limit 1`
  const attribute = p.attribute ?? []

  const [tpl] = await db<{ id: string }[]>`
    insert into product_templates (
      name, uom_id, list_price, standard_cost, weight_g,
      can_be_sold, can_be_purchased, route_buy, route_manufacture, description_sale)
    values (${p.name}, ${uom.id},
            ${p.verkaufspreis ?? 0}, ${p.einstandspreis ?? 0}, ${p.gewicht_g ?? 0},
            ${p.verkaufbar ?? true}, ${p.einkaufbar ?? false},
            ${p.route === 'kaufen'}, ${p.route === 'fertigen'},
            ${p.beschreibung ?? null})
    returning id`

  // Attribute und Werte über den Namen abgleichen: „Farbe" existiert meist
  // schon, ein fehlender Wert („Grün") wird ergänzt statt ein zweites
  // Attribut „Farbe" anzulegen.
  for (const [i, attr] of attribute.entries()) {
    const [attribut] = await db<{ id: string }[]>`
      insert into product_attributes (name, sequence)
      values (${attr.name}, ${(i + 1) * 10})
      on conflict (name) do update set name = excluded.name
      returning id`

    const [line] = await db<{ id: string }[]>`
      insert into product_template_attribute_lines (template_id, attribute_id)
      values (${tpl.id}, ${attribut.id})
      on conflict (template_id, attribute_id) do update set attribute_id = excluded.attribute_id
      returning id`

    for (const [j, wert] of attr.werte.entries()) {
      const [value] = await db<{ id: string }[]>`
        insert into product_attribute_values (attribute_id, name, html_color, sequence)
        values (${attribut.id}, ${wert.name}, ${wert.farbe ?? null}, ${(j + 1) * 10})
        on conflict (attribute_id, name) do update
          set html_color = coalesce(excluded.html_color, product_attribute_values.html_color)
        returning id`
      await db`
        insert into product_template_attribute_values (line_id, value_id, price_extra)
        values (${line.id}, ${value.id}, ${wert.aufpreis ?? 0})
        on conflict (line_id, value_id) do update set price_extra = excluded.price_extra`
    }
  }

  await db`select generate_variants(${tpl.id})`

  // Artikelnummern: Präfix plus Kürzel je Attributwert (ohne Kürzel die
  // ersten zwei Buchstaben). Kollidiert eine Nummer, bleibt sie leer statt
  // die ganze Anlage scheitern zu lassen — nachtragen geht in der Oberfläche.
  const praefix = (p.sku ?? '').trim().toUpperCase()
  let benannt = 0
  if (praefix) {
    const kuerzel = new Map<string, string>()
    for (const attr of attribute) {
      for (const wert of attr.werte) {
        kuerzel.set(
          `${attr.name} ${wert.name}`,
          (wert.kuerzel ?? wert.name.slice(0, 2)).toUpperCase().replace(/[^A-Z0-9]/g, ''),
        )
      }
    }

    const varianten = await db<{ id: string; teile: string[] }[]>`
      select pv.id,
             coalesce(array_agg(a.name || ' ' || v.name order by al.sequence, a.name)
                      filter (where v.name is not null), '{}') as teile
      from product_variants pv
      left join product_variant_attribute_values pvav on pvav.variant_id = pv.id
      left join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
      left join product_template_attribute_lines al on al.id = ptav.line_id
      left join product_attributes a on a.id = al.attribute_id
      left join product_attribute_values v on v.id = ptav.value_id
      where pv.template_id = ${tpl.id} and pv.active
      group by pv.id`

    for (const variante of varianten) {
      const nummer = [praefix, ...variante.teile.map((t) => kuerzel.get(t) ?? '')]
        .filter(Boolean)
        .join('-')
      // Vergebene Nummern werden übersprungen statt eine Ausnahme auszulösen:
      // ein Eindeutigkeitsfehler würde die umgebende Transaktion abbrechen und
      // damit die ganze Produktanlage mitnehmen.
      const treffer = await db`
        update product_variants set sku = ${nummer}
        where id = ${variante.id}
          and not exists (select 1 from product_variants x where x.sku = ${nummer})`
      if (treffer.count > 0) benannt++
    }
  }

  const [{ anzahl }] = await db<{ anzahl: number }[]>`
    select count(*)::int as anzahl from product_variants
    where template_id = ${tpl.id} and active`

  await db`select log_event('product_template', ${tpl.id}, 'note',
    ${'Über die KI-Analyse angelegt'}, ${actor})`

  return { templateId: tpl.id, varianten: anzahl, benannt }
}
