-- ============================================================================
-- 0090  Odoo-Stücklisten per API in ein bestehendes KRNL
-- ----------------------------------------------------------------------------
-- Der Betreiber übernimmt aus Odoo nur Stücklisten, ihre Komponenten und
-- deren Lieferanten — Tastaturen und Switch-Tester stehen schon aus Shopify
-- in KRNL (Entscheidungslog 2026-09-29). Die Übernahme ordnet per SKU zu und
-- schreibt je Variante, wo Varianten verschiedene Listen brauchen.
--
--   1. boms.herkunft: 'odoo' = von der Übernahme geschrieben. Nur solche
--      ersetzt ein weiterer Lauf; von Hand angelegte (null) bleiben.
--   2. odoo_verweise.herkunft: 'angelegt' (von KRNL neu angelegt) oder
--      'zugeordnet' (bestand schon, per SKU verbunden — wird nie umbenannt).
--   3. resolve_bom/resolve_kit: eine Varianten-Stückliste gilt NUR für ihre
--      Variante. Bis hier war die Stückliste einer Geschwister-Variante ein
--      Kandidat und schlug sogar die Vorlagen-Stückliste (Sortierung
--      false vor null) — eine Variante ohne eigene Liste bekam die falschen
--      Komponenten.
-- ============================================================================

alter table boms add column herkunft text check (herkunft in ('odoo'));
comment on column boms.herkunft is
  'Woher die Stückliste stammt: odoo = Odoo-Übernahme (0090), null = in KRNL angelegt';

alter table odoo_verweise
  add column herkunft text not null default 'angelegt' check (herkunft in ('angelegt', 'zugeordnet'));
comment on column odoo_verweise.herkunft is
  'angelegt = KRNL-Datensatz aus Odoo neu angelegt; zugeordnet = bestehender KRNL-Datensatz per SKU verbunden';

create or replace function resolve_bom(p_variant uuid) returns uuid
language sql stable
set search_path = public, pg_temp as $$
  select b.id
  from boms b
  join product_variants pv on pv.template_id = b.template_id
  where pv.id = p_variant and b.active and b.bom_type = 'manufacture'
    and (b.variant_id is null or b.variant_id = p_variant)
  order by (b.variant_id is not null) desc, b.created_at
  limit 1;
$$;

create or replace function resolve_kit(p_variant uuid) returns uuid
language sql stable
set search_path = public, pg_temp as $$
  select b.id
  from boms b
  join product_variants pv on pv.template_id = b.template_id
  where pv.id = p_variant and b.active and b.bom_type = 'kit'
    and (b.variant_id is null or b.variant_id = p_variant)
  order by (b.variant_id is not null) desc, b.created_at
  limit 1;
$$;
