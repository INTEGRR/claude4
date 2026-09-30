-- ============================================================================
-- 0098  „Auf Varianten anwenden" wie in Odoo: je Attribut ODER, über UND
-- ----------------------------------------------------------------------------
-- Bisher galt eine gefilterte Stücklistenzeile, wenn die Variante IRGENDEINEN
-- der Filterwerte trug. Odoo liest den Filter je Attribut: die Variante muss
-- für jedes Attribut, das im Filter vorkommt, einen der Werte dieses
-- Attributs tragen („Mounting Plate: PC" UND „Layout: ISO"). Bei Filtern mit
-- nur einem Attribut ist beides gleich; bei Filtern über mehrere Attribute
-- galt bisher zu viel. Die Odoo-Übernahme schreibt jetzt EINE Stückliste je
-- Artikel mit solchen Filtern (Entscheidungslog 2026-09-30) — dafür muss
-- KRNL sie genauso lesen.
-- ============================================================================

create or replace function bom_components_for_variant(p_bom uuid, p_variant uuid)
returns table (
  bom_line_id uuid,
  sequence int,
  component_variant_id uuid,
  qty numeric,
  uom_id uuid,
  manual_consumption boolean
)
language sql stable as $$
  select bl.id, bl.sequence, bl.component_variant_id, bl.qty, bl.uom_id, bl.manual_consumption
  from bom_lines bl
  where bl.bom_id = p_bom
    -- ohne Filter gilt die Zeile für alle Varianten; mit Filter darf es kein
    -- Attribut geben, für das die Variante keinen der Filterwerte trägt
    and not exists (
      select 1
      from bom_line_variant_filters f
      join product_template_attribute_values ptav on ptav.id = f.ptav_id
      join product_template_attribute_lines al on al.id = ptav.line_id
      where f.bom_line_id = bl.id
      group by al.attribute_id
      having not bool_or(exists (
        select 1 from product_variant_attribute_values pvav
        where pvav.variant_id = p_variant and pvav.ptav_id = f.ptav_id)))
  order by bl.sequence, bl.id;
$$;

comment on function bom_components_for_variant(uuid, uuid) is
  'Stücklistenpositionen einer Variante (0098, Odoo-Semantik): ohne Filter alle; mit Filter je Attribut einer der Werte, über Attribute alle';
