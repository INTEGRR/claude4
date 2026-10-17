-- ============================================================================
-- 0121 — Vorsteuer-Standard nach Lieferantenland (UX-Audit, Entscheidungslog
-- 2026-10-17)
--
-- Bestellzeilen bekamen die Einkaufssteuer des Produkts, ohne Steuer am
-- Produkt pauschal 19 % — auch beim Lieferanten in China. Ein Lieferant
-- außerhalb Deutschlands stellt keine deutsche Umsatzsteuer in Rechnung
-- (Drittland: EUSt erst beim Zoll; EU: innergemeinschaftlicher Erwerb, die
-- Erwerbsteuer meldet der Käufer selbst) — der Bestellwert ist netto = brutto.
-- Die steuerliche Abbildung von EUSt/Erwerbsteuer bleibt Sache der
-- Buchhaltungsanbindung (auf Hold).
--
--  * einkauf_steuer_id(vendor, variant) / einkauf_steuersatz(vendor, variant)
--    Lieferant mit Land ≠ DE → keine Steuer (0 %); sonst Produktsteuer, ohne
--    Produktsteuer 19 % (unverändert). Ohne Land gilt Inland.
-- ============================================================================

create or replace function einkauf_lieferant_ausland(p_vendor uuid) returns boolean
language sql stable as $$
  select coalesce((select upper(nullif(trim(country_code), '')) not in ('DE', 'DEU')
                   from partners where id = p_vendor), false)
$$;

create or replace function einkauf_steuer_id(p_vendor uuid, p_variant uuid) returns uuid
language sql stable as $$
  select case when einkauf_lieferant_ausland(p_vendor) then null else pt.purchase_tax_id end
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant
$$;

create or replace function einkauf_steuersatz(p_vendor uuid, p_variant uuid) returns numeric
language sql stable as $$
  select case when einkauf_lieferant_ausland(p_vendor) then 0
              else coalesce((select amount from taxes where id = pt.purchase_tax_id), 19) end
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant
$$;

comment on function einkauf_steuersatz(uuid, uuid) is
  'Standard-Steuersatz einer Bestellzeile (0121): Lieferant im Ausland → 0 %, sonst Produktsteuer bzw. 19 %.';
