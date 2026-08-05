-- ===========================================================================
-- Stammdaten: Maßeinheiten, Kontakte, Produkte, Attribute, Varianten
-- ===========================================================================

-- --- Maßeinheiten ----------------------------------------------------------
-- Umrechnung ausschließlich innerhalb einer Kategorie (Odoo-Regel). Jede
-- Kategorie hat genau eine Referenzeinheit mit ratio = 1.
create table uom_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('uom_categories');

create table uoms (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references uom_categories on delete restrict,
  name         text not null,
  ratio        numeric(16,6) not null default 1 check (ratio > 0),
  is_reference boolean not null default false,
  rounding     numeric(16,6) not null default 0.01 check (rounding > 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  unique (category_id, name)
);
select attach_touch_trigger('uoms');

-- Genau eine Referenzeinheit je Kategorie.
create unique index uoms_one_reference_per_category
  on uoms (category_id) where is_reference;

comment on column uoms.ratio is
  'Wie viele Referenzeinheiten eine Einheit dieser Art enthält. "Box à 12" = 12.';

-- Rechnet eine Menge zwischen zwei Einheiten derselben Kategorie um.
create or replace function uom_convert(p_qty numeric, p_from uuid, p_to uuid)
returns numeric
language plpgsql stable as $$
declare
  f uoms%rowtype;
  t uoms%rowtype;
begin
  if p_from = p_to or p_to is null or p_from is null then
    return p_qty;
  end if;

  select * into f from uoms where id = p_from;
  select * into t from uoms where id = p_to;
  if f.id is null or t.id is null then
    raise exception 'Unbekannte Maßeinheit bei der Umrechnung';
  end if;
  if f.category_id <> t.category_id then
    raise exception 'Maßeinheiten % und % gehören zu verschiedenen Kategorien und sind nicht umrechenbar', f.name, t.name;
  end if;

  return p_qty * f.ratio / t.ratio;
end $$;


-- --- Kontakte (Kunden und Lieferanten in einer Tabelle, wie Odoo) ----------
create table partners (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  is_company          boolean not null default false,
  is_customer         boolean not null default false,
  is_vendor           boolean not null default false,
  email               text,
  phone               text,
  street              text,
  house_number        text,   -- getrennt, weil DHL Straße und Hausnummer separat braucht
  street2             text,
  zip                 text,
  city                text,
  country_code        text not null default 'DE',   -- ISO alpha-2 im System
  vat                 text,
  payment_terms_days  int,
  shopify_customer_id text unique,
  notes               text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
select attach_touch_trigger('partners');
create index partners_name_idx on partners (lower(name));
create index partners_vendor_idx on partners (is_vendor) where is_vendor;
create index partners_customer_idx on partners (is_customer) where is_customer;


-- --- Produktvorlagen -------------------------------------------------------
create type product_type as enum ('goods', 'service');
create type invoice_policy as enum ('order', 'delivery');
create type bill_policy as enum ('ordered', 'received');

create table product_templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  type              product_type not null default 'goods',
  uom_id            uuid not null references uoms on delete restrict,
  purchase_uom_id   uuid references uoms on delete restrict,
  list_price        numeric(16,2) not null default 0,
  standard_cost     numeric(16,2) not null default 0,
  weight_g          int not null default 0,       -- für DHL-Paketgewicht
  invoice_policy    invoice_policy not null default 'order',
  bill_policy       bill_policy not null default 'received',
  route_mto         boolean not null default false,
  route_manufacture boolean not null default false,
  route_buy         boolean not null default false,
  can_be_sold       boolean not null default true,
  can_be_purchased  boolean not null default false,
  description       text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('product_templates');
create index product_templates_name_idx on product_templates (lower(name));

-- Einkaufs- und Lagereinheit müssen zur selben Kategorie gehören.
create or replace function check_product_uom_categories() returns trigger
language plpgsql as $$
declare
  c1 uuid; c2 uuid;
begin
  if new.purchase_uom_id is null then return new; end if;
  select category_id into c1 from uoms where id = new.uom_id;
  select category_id into c2 from uoms where id = new.purchase_uom_id;
  if c1 <> c2 then
    raise exception 'Einkaufseinheit und Lagereinheit müssen zur selben Maßeinheiten-Kategorie gehören';
  end if;
  return new;
end $$;

create trigger product_templates_uom_check
  before insert or update of uom_id, purchase_uom_id on product_templates
  for each row execute function check_product_uom_categories();


-- --- Attribute und Werte ---------------------------------------------------
create type attribute_display as enum ('select', 'radio', 'color', 'pills');

create table product_attributes (
  id           uuid primary key default gen_random_uuid(),
  name         text unique not null,
  display_type attribute_display not null default 'select',
  sequence     int not null default 10,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
select attach_touch_trigger('product_attributes');

create table product_attribute_values (
  id           uuid primary key default gen_random_uuid(),
  attribute_id uuid not null references product_attributes on delete cascade,
  name         text not null,
  html_color   text,
  sequence     int not null default 10,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  unique (attribute_id, name)
);
select attach_touch_trigger('product_attribute_values');

-- Welche Attribute hängen an einer Produktvorlage
create table product_template_attribute_lines (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references product_templates on delete cascade,
  attribute_id uuid not null references product_attributes on delete restrict,
  sequence     int not null default 10,
  unique (template_id, attribute_id)
);

-- Welche Werte davon sind ausgewählt (inkl. Aufpreis je Wert).
-- Diese Zeilen sind der Anker für "Auf Varianten anwenden" in Stücklisten.
create table product_template_attribute_values (
  id          uuid primary key default gen_random_uuid(),
  line_id     uuid not null references product_template_attribute_lines on delete cascade,
  value_id    uuid not null references product_attribute_values on delete restrict,
  price_extra numeric(16,2) not null default 0,
  unique (line_id, value_id)
);


-- --- Varianten -------------------------------------------------------------
-- Alle Belege und Bestände referenzieren ausschließlich Varianten. Produkte
-- ohne Attribute bekommen automatisch genau eine Variante.
create table product_variants (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references product_templates on delete cascade,
  sku                text unique,
  barcode            text unique,
  shopify_variant_id text unique,
  price_extra        numeric(16,2) not null default 0,  -- Summe der Attributaufpreise
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
select attach_touch_trigger('product_variants');
create index product_variants_template_idx on product_variants (template_id);

create table product_variant_attribute_values (
  variant_id uuid not null references product_variants on delete cascade,
  ptav_id    uuid not null references product_template_attribute_values on delete cascade,
  primary key (variant_id, ptav_id)
);
create index pvav_ptav_idx on product_variant_attribute_values (ptav_id);


-- Anzeigename einer Variante: "Tastatur (Farbe: Weiß, Layout: DE)"
create or replace function variant_display_name(p_variant uuid) returns text
language sql stable as $$
  select t.name || coalesce(' (' || string_agg(a.name || ': ' || v.name, ', '
           order by al.sequence, a.name) || ')', '')
  from product_variants pv
  join product_templates t on t.id = pv.template_id
  left join product_variant_attribute_values pvav on pvav.variant_id = pv.id
  left join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
  left join product_template_attribute_lines al on al.id = ptav.line_id
  left join product_attribute_values v on v.id = ptav.value_id
  left join product_attributes a on a.id = al.attribute_id
  where pv.id = p_variant
  group by t.name;
$$;

-- Denormalisierter Anzeigename für Listen/Suche, per Trigger gepflegt.
alter table product_variants add column display_name text;

create or replace function refresh_variant_display_name(p_variant uuid) returns void
language sql as $$
  update product_variants set display_name = variant_display_name(p_variant)
  where id = p_variant;
$$;

create or replace function trg_variant_name_from_values() returns trigger
language plpgsql as $$
begin
  perform refresh_variant_display_name(coalesce(new.variant_id, old.variant_id));
  return null;
end $$;

create trigger pvav_refresh_name
  after insert or update or delete on product_variant_attribute_values
  for each row execute function trg_variant_name_from_values();

create or replace function trg_variant_name_on_insert() returns trigger
language plpgsql as $$
begin
  perform refresh_variant_display_name(new.id);
  return null;
end $$;

create trigger variants_refresh_name
  after insert on product_variants
  for each row execute function trg_variant_name_on_insert();


-- --- Variantengenerierung --------------------------------------------------
-- Erzeugt für eine Vorlage alle fehlenden Attributkombinationen (kartesisches
-- Produkt) und deaktiviert Varianten, deren Kombination es nicht mehr gibt.
-- Vorlagen ohne Attribute erhalten genau eine attributlose Variante.
create or replace function generate_variants(p_template uuid) returns int
language plpgsql as $$
declare
  v_lines uuid[];
  v_combo uuid[];
  v_existing uuid;
  v_variant uuid;
  v_created int := 0;
  v_all_combos uuid[][];
  v_query text;
begin
  select array_agg(id order by sequence) into v_lines
  from product_template_attribute_lines where template_id = p_template;

  -- Ohne Attribute: genau eine attributlose Variante sicherstellen.
  if v_lines is null or array_length(v_lines, 1) is null then
    select id into v_existing from product_variants
    where template_id = p_template and active
      and not exists (select 1 from product_variant_attribute_values where variant_id = product_variants.id)
    limit 1;
    if v_existing is null then
      insert into product_variants (template_id) values (p_template);
      v_created := 1;
    end if;
    return v_created;
  end if;

  -- Kartesisches Produkt über alle Attributzeilen dynamisch bilden.
  v_query := 'select array[';
  for i in 1 .. array_length(v_lines, 1) loop
    if i > 1 then v_query := v_query || ', '; end if;
    v_query := v_query || format('v%s.id', i);
  end loop;
  v_query := v_query || '] from ';
  for i in 1 .. array_length(v_lines, 1) loop
    if i > 1 then v_query := v_query || ' cross join '; end if;
    v_query := v_query || format(
      '(select id from product_template_attribute_values where line_id = %L) v%s',
      v_lines[i], i);
  end loop;

  for v_combo in execute v_query loop
    -- Gibt es bereits eine Variante mit exakt dieser Wertemenge?
    select pv.id into v_existing
    from product_variants pv
    where pv.template_id = p_template
      and (select array_agg(ptav_id order by ptav_id)
           from product_variant_attribute_values where variant_id = pv.id)
          = (select array_agg(x order by x) from unnest(v_combo) x)
    limit 1;

    if v_existing is null then
      insert into product_variants (template_id) values (p_template) returning id into v_variant;
      insert into product_variant_attribute_values (variant_id, ptav_id)
      select v_variant, unnest(v_combo);
      v_created := v_created + 1;
    else
      update product_variants set active = true where id = v_existing and not active;
    end if;
  end loop;

  -- Aufpreise aus den Attributwerten übernehmen.
  update product_variants pv set price_extra = coalesce((
    select sum(ptav.price_extra)
    from product_variant_attribute_values pvav
    join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
    where pvav.variant_id = pv.id), 0)
  where pv.template_id = p_template;

  -- Attributlose Varianten dieser Vorlage sind nach der Attributvergabe
  -- gegenstandslos - deaktivieren statt löschen (Belege referenzieren sie evtl.).
  update product_variants pv set active = false
  where pv.template_id = p_template
    and not exists (select 1 from product_variant_attribute_values where variant_id = pv.id);

  return v_created;
end $$;


-- --- Lieferantenpreise -----------------------------------------------------
create table vendor_prices (
  id                  uuid primary key default gen_random_uuid(),
  vendor_id           uuid not null references partners on delete cascade,
  template_id         uuid not null references product_templates on delete cascade,
  variant_id          uuid references product_variants on delete cascade,
  min_qty             numeric(16,4) not null default 0,
  price               numeric(16,2) not null,
  currency            text not null default 'EUR',
  lead_time_days      int not null default 0,
  vendor_product_code text,
  sequence            int not null default 10,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
select attach_touch_trigger('vendor_prices');
create index vendor_prices_lookup_idx on vendor_prices (template_id, vendor_id, sequence);

-- Bester Lieferantenpreis für eine Variante und Menge.
create or replace function best_vendor_price(p_variant uuid, p_vendor uuid, p_qty numeric)
returns vendor_prices
language sql stable as $$
  select vp.*
  from vendor_prices vp
  join product_variants pv on pv.template_id = vp.template_id
  where pv.id = p_variant
    and vp.vendor_id = p_vendor
    and (vp.variant_id is null or vp.variant_id = p_variant)
    and vp.min_qty <= p_qty
  order by vp.sequence, vp.min_qty desc
  limit 1;
$$;
