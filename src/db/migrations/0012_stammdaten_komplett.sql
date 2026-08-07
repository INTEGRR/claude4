-- ===========================================================================
-- Odoo-Vervollständigung I: Stammdaten
-- Kategorien, Steuern, Zahlungsbedingungen, Incoterms, Tags, Kuppelprodukte
-- sowie fehlende Felder an Kontakten, Produkten und Lieferantenpreisen.
-- Feldnamen folgen den Odoo-18-Modellen (res.partner, product.template,
-- product.supplierinfo, account.tax, account.payment.term, account.incoterms).
-- ===========================================================================

-- --- Produktkategorien (product.category) ----------------------------------
create table product_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references product_categories on delete restrict,
  full_path  text not null,          -- "Alle/Komponenten/Elektronik", Trigger-gepflegt
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('product_categories');
create index product_categories_parent_idx on product_categories (parent_id);

create or replace function trg_category_path() returns trigger
language plpgsql as $$
declare
  parent_path text;
begin
  if new.parent_id is null then
    new.full_path := new.name;
  else
    select full_path into parent_path from product_categories where id = new.parent_id;
    new.full_path := parent_path || '/' || new.name;
  end if;
  return new;
end $$;
create trigger category_path before insert or update of name, parent_id
  on product_categories for each row execute function trg_category_path();

insert into product_categories (name, full_path) values ('Alle', 'Alle');

-- --- Steuern (account.tax, reduziert) --------------------------------------
create table taxes (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  amount        numeric(8,4) not null,
  amount_type   text not null default 'percent' check (amount_type in ('percent', 'fixed')),
  type_tax_use  text not null check (type_tax_use in ('sale', 'purchase')),
  price_include boolean not null default false,
  description   text,                -- Belegtext, z. B. "inkl. 19 % USt"
  sequence      int not null default 10,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
select attach_touch_trigger('taxes');

insert into taxes (name, amount, type_tax_use, description, sequence) values
  ('19 % USt',                19, 'sale',     'zzgl. 19 % USt', 10),
  ('7 % USt',                  7, 'sale',     'zzgl. 7 % USt', 20),
  ('0 % steuerfreie Ausfuhr',  0, 'sale',     'steuerfreie Ausfuhrlieferung §4 Nr. 1a UStG', 30),
  ('0 % innergem. Lieferung',  0, 'sale',     'steuerfreie innergemeinschaftliche Lieferung §4 Nr. 1b UStG', 40),
  ('19 % Vorsteuer',          19, 'purchase', '19 % abziehbare Vorsteuer', 10),
  ('7 % Vorsteuer',            7, 'purchase', '7 % abziehbare Vorsteuer', 20);

-- --- Zahlungsbedingungen (account.payment.term, einzeilig) -----------------
create table payment_terms (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  nb_days             int not null default 0,
  delay_type          text not null default 'days_after'
                      check (delay_type in ('days_after', 'days_after_end_of_month')),
  -- Skonto (early payment discount)
  early_discount      boolean not null default false,
  discount_percentage numeric(5,2),
  discount_days       int,
  sequence            int not null default 10,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
select attach_touch_trigger('payment_terms');

insert into payment_terms (name, nb_days, sequence) values
  ('Sofort fällig', 0, 10),
  ('14 Tage netto', 14, 20),
  ('30 Tage netto', 30, 30);
insert into payment_terms (name, nb_days, early_discount, discount_percentage, discount_days, sequence)
  values ('30 Tage netto, 2 % Skonto binnen 10 Tagen', 30, true, 2, 10, 40);

-- Fälligkeit aus Bedingung + Basisdatum (für Lieferantenrechnungen).
create or replace function payment_term_due_date(p_term uuid, p_base date) returns date
language sql stable as $$
  select case
    when t.delay_type = 'days_after_end_of_month'
      then (date_trunc('month', p_base) + interval '1 month')::date + t.nb_days
    else p_base + t.nb_days
  end
  from payment_terms t where t.id = p_term;
$$;

-- --- Incoterms (account.incoterms) -----------------------------------------
create table incoterms (
  code text primary key,
  name text not null
);
insert into incoterms (code, name) values
  ('EXW', 'Ab Werk'),
  ('FCA', 'Frei Frachtführer'),
  ('CPT', 'Frachtfrei'),
  ('CIP', 'Frachtfrei versichert'),
  ('DAP', 'Geliefert benannter Ort'),
  ('DPU', 'Geliefert benannter Ort entladen'),
  ('DDP', 'Geliefert verzollt'),
  ('FAS', 'Frei Längsseite Schiff'),
  ('FOB', 'Frei an Bord'),
  ('CFR', 'Kosten und Fracht'),
  ('CIF', 'Kosten, Versicherung und Fracht');

-- --- Tags (vereinheitlicht: res.partner.category, product.tag, crm.tag, repair.tags)
create table tags (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('partner', 'product', 'sale', 'repair')),
  name       text not null,
  color      text,
  created_at timestamptz not null default now(),
  unique (kind, name)
);

create table partner_tag_links (
  partner_id uuid not null references partners on delete cascade,
  tag_id     uuid not null references tags on delete cascade,
  primary key (partner_id, tag_id)
);
create table product_tag_links (
  template_id uuid not null references product_templates on delete cascade,
  tag_id      uuid not null references tags on delete cascade,
  primary key (template_id, tag_id)
);
create table sales_order_tag_links (
  order_id uuid not null references sales_orders on delete cascade,
  tag_id   uuid not null references tags on delete cascade,
  primary key (order_id, tag_id)
);
create table repair_order_tag_links (
  repair_id uuid not null references repair_orders on delete cascade,
  tag_id    uuid not null references tags on delete cascade,
  primary key (repair_id, tag_id)
);

-- --- Kuppelprodukte (mrp.bom.byproduct) ------------------------------------
create table bom_byproducts (
  id         uuid primary key default gen_random_uuid(),
  bom_id     uuid not null references boms on delete cascade,
  variant_id uuid not null references product_variants on delete restrict,
  qty        numeric(16,4) not null check (qty > 0),
  uom_id     uuid not null references uoms on delete restrict,
  cost_share numeric(5,2) not null default 0 check (cost_share between 0 and 100),
  created_at timestamptz not null default now()
);
create index bom_byproducts_bom_idx on bom_byproducts (bom_id);

-- --- Kontakte: fehlende res.partner-Felder ---------------------------------
alter table partners
  add column parent_id uuid references partners on delete set null,        -- res.partner.parent_id
  add column partner_type text not null default 'contact'
    check (partner_type in ('contact', 'invoice', 'delivery', 'other')),   -- res.partner.type
  add column user_id uuid references users on delete set null,             -- Verkäufer (user_id)
  add column customer_payment_term_id uuid references payment_terms on delete set null,
  add column supplier_payment_term_id uuid references payment_terms on delete set null,
  add column ref text,                                                     -- interne Referenz
  add column website text,
  add column job_title text,                                               -- res.partner.function
  add column mobile text,
  add column company_registry text;                                        -- HRB-Nr.
create index partners_parent_idx on partners (parent_id);

-- Backfill: bisheriges Zahlungsziel in Tagen → Zahlungsbedingung (Lieferant).
insert into payment_terms (name, nb_days, sequence)
select distinct p.payment_terms_days || ' Tage netto', p.payment_terms_days, 100
from partners p
where p.payment_terms_days is not null and p.payment_terms_days > 0
on conflict (name) do nothing;

update partners p set supplier_payment_term_id = t.id
from payment_terms t
where p.payment_terms_days is not null
  and t.nb_days = p.payment_terms_days
  and p.supplier_payment_term_id is null;
comment on column partners.payment_terms_days is
  'Veraltet — ersetzt durch supplier_payment_term_id (0012).';

-- --- Produkte: fehlende product.template-Felder ----------------------------
alter table product_templates
  add column category_id uuid references product_categories on delete restrict,
  add column sale_delay int not null default 0,                 -- Customer Lead Time (Tage)
  add column hs_code text,                                      -- Zolltarifnummer (stock_delivery)
  add column country_of_origin text,                            -- Ursprungsland (ISO-2)
  add column sale_tax_id uuid references taxes on delete set null,
  add column purchase_tax_id uuid references taxes on delete set null,
  add column description_sale text,
  add column description_purchase text,
  add column description_picking text,
  add column responsible_id uuid references users on delete set null;

-- Kategorie ist wie in Odoo Pflicht; Bestand + künftige Inserts ohne Angabe
-- fallen auf die Wurzelkategorie zurück (Trigger statt Spalten-Default,
-- weil ein Default keine Unterabfrage sein kann).
update product_templates
set category_id = (select id from product_categories where parent_id is null limit 1)
where category_id is null;
alter table product_templates alter column category_id set not null;

create or replace function trg_template_default_category() returns trigger
language plpgsql as $$
begin
  if new.category_id is null then
    select id into new.category_id from product_categories where parent_id is null limit 1;
  end if;
  return new;
end $$;
create trigger template_default_category before insert on product_templates
  for each row execute function trg_template_default_category();

-- Standardsteuern für alles Vorhandene: 19 % VK / 19 % Vorsteuer.
update product_templates set
  sale_tax_id = coalesce(sale_tax_id,
    (select id from taxes where type_tax_use = 'sale' and amount = 19 limit 1)),
  purchase_tax_id = coalesce(purchase_tax_id,
    (select id from taxes where type_tax_use = 'purchase' and amount = 19 limit 1));

-- --- Lieferantenpreise: fehlende product.supplierinfo-Felder ---------------
alter table vendor_prices
  add column discount numeric(5,2) not null default 0,          -- Lieferantenrabatt %
  add column date_start date,                                   -- Preisgültigkeit
  add column date_end date,
  add column product_name text;                                 -- Artikelname des Lieferanten

-- best_vendor_price berücksichtigt jetzt die Preisgültigkeit (date_start/end).
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
    and (vp.date_start is null or vp.date_start <= current_date)
    and (vp.date_end is null or vp.date_end >= current_date)
  order by vp.sequence, vp.min_qty desc
  limit 1;
$$;

-- Nettopreis nach Lieferantenrabatt.
create or replace function vendor_price_net(p_price numeric, p_discount numeric)
returns numeric
language sql immutable as $$
  select round(p_price * (1 - coalesce(p_discount, 0) / 100.0), 2);
$$;
