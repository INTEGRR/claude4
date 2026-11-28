-- 0145: Variantennamen folgen dem Produktnamen (Entscheidungslog 2026-11-28).
--
-- product_variants.display_name ist der gespeicherte Anzeigename („Produkt
-- (Attribut: Wert)"). Er wurde nur beim Anlegen und bei Attributänderungen
-- neu gebildet — benannte Shopify das Produkt um, blieben die Varianten
-- beim alten Namen stehen. Folge am Inventurtag: Suche und Auswahlfelder
-- kannten „GATERON Switches", die Listen zeigten „GATERON G Pro 3.0
-- Switches". Jetzt zieht die Datenbank die Namen selbst nach — beim
-- Umbenennen des Produkts, eines Attributs oder eines Attributwerts.
-- Bestände, Belege und Verknüpfungen bleiben unberührt.

create or replace function trg_variantennamen_produkt() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  update product_variants set display_name = variant_display_name(id)
  where template_id = new.id and display_name is distinct from variant_display_name(id);
  return null;
end $$;

create trigger product_templates_variantennamen
  after update of name on product_templates
  for each row when (new.name is distinct from old.name)
  execute function trg_variantennamen_produkt();

create or replace function trg_variantennamen_wert() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  update product_variants pv set display_name = variant_display_name(pv.id)
  where pv.id in (select pvav.variant_id
                  from product_variant_attribute_values pvav
                  join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
                  where ptav.value_id = new.id)
    and pv.display_name is distinct from variant_display_name(pv.id);
  return null;
end $$;

create trigger product_attribute_values_variantennamen
  after update of name on product_attribute_values
  for each row when (new.name is distinct from old.name)
  execute function trg_variantennamen_wert();

create or replace function trg_variantennamen_attribut() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  update product_variants pv set display_name = variant_display_name(pv.id)
  where pv.id in (select pvav.variant_id
                  from product_variant_attribute_values pvav
                  join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
                  join product_template_attribute_lines al on al.id = ptav.line_id
                  where al.attribute_id = new.id)
    and pv.display_name is distinct from variant_display_name(pv.id);
  return null;
end $$;

create trigger product_attributes_variantennamen
  after update of name on product_attributes
  for each row when (new.name is distinct from old.name)
  execute function trg_variantennamen_attribut();

-- Einmalig heilen, was schon auseinandergelaufen ist.
update product_variants set display_name = variant_display_name(id)
where display_name is distinct from variant_display_name(id);
