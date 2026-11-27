-- ===========================================================================
-- 0136  Release-Schutz II: Kontingent je knappem Teil und Buch je Angebot
-- ===========================================================================
-- Entscheidungslog 2026-11-27 (Pakete S1, S3, S5–S7).
--
-- Das Prinzip: Die Summe der im Shop angebotenen Mengen aller Angebote, die
-- ein Teil brauchen, übersteigt nie den freien Bestand dieses Teils. Dann
-- zählt Shopify selbst herunter, und es kann auch dann nichts überverkauft
-- werden, wenn KRNL langsam ist oder steht.
--
-- Zwei Bausteine:
--
-- 1. KONTINGENT. Der freie Bestand jedes Teils wird auf die Angebote
--    verteilt, die es brauchen — nach Gewicht (erwartete Nachfrage). Das
--    Gewicht einer Variante ist das Produkt aus dem Gewicht des Artikels und
--    den Gewichten ihrer Optionswerte (leer = 1); was sich gerade gut
--    verkauft, bekommt von selbst mehr.
--
-- 2. BUCH. KRNL führt je Angebot Buch darüber, was der Shop zeigt, wenn
--    alle Bestellungen bekannt sind (pushed_qty), und sendet nur noch die
--    DIFFERENZ zum neuen Kontingent — nie mehr eine absolute Menge. Ein
--    Kauf, den KRNL noch nicht kennt, hat den Shop schon heruntergezählt;
--    eine Differenz lässt das stehen, eine absolute Menge überschriebe es.
--    Jede eingelesene Bestellung zieht ihre Menge vom Buch ab (genau
--    einmal), ein Storno zählt sie wieder dazu. Absolut gesetzt wird nur
--    beim ersten Mal, beim Not-Aus und beim Heilen einer Abweichung —
--    buch_ab merkt, ab wann Bestellungen gegen das Buch zählen.

alter table shopify_inventory_state
  add column buch_ab timestamptz,
  add column kontingent int,
  add column kontingent_at timestamptz;
comment on column shopify_inventory_state.pushed_qty is
  'Buch: was der Shop zeigt, wenn alle Bestellungen bekannt sind (0136). null = noch nie gesetzt';
comment on column shopify_inventory_state.buch_ab is
  'Zeitpunkt der letzten absoluten Meldung — nur später angelegte Bestellungen zählen gegen das Buch (0136)';
comment on column shopify_inventory_state.kontingent is
  'Zuletzt berechnetes Kontingent dieses Angebots (0136)';

alter table shopify_zweitangebote
  add column buch_ab timestamptz,
  add column kontingent int,
  add column kontingent_at timestamptz,
  add column shop_gewicht numeric
    constraint shopify_zweitangebote_shop_gewicht_check check (shop_gewicht is null or shop_gewicht > 0);

alter table product_templates
  add column shop_gewicht numeric
    constraint product_templates_shop_gewicht_check check (shop_gewicht is null or shop_gewicht > 0);
comment on column product_templates.shop_gewicht is
  'Kontingent: erwartete Nachfrage dieses Artikels im Verhältnis zu anderen (leer = 1) — 0136';

alter table product_template_attribute_values
  add column shop_gewicht numeric
    constraint ptav_shop_gewicht_check check (shop_gewicht is null or shop_gewicht > 0);
comment on column product_template_attribute_values.shop_gewicht is
  'Kontingent: erwartete Nachfrage dieses Optionswerts im Verhältnis zu den anderen (leer = 1) — 0136';

-- Gewicht einer Variante: Artikel × Produkt der Optionswerte.
create or replace function shop_gewicht(p_variant uuid) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select coalesce(pt.shop_gewicht, 1)
       * coalesce((select exp(sum(ln(coalesce(ptav.shop_gewicht, 1))))
                   from product_variant_attribute_values a
                   join product_template_attribute_values ptav on ptav.id = a.ptav_id
                   where a.variant_id = pv.id), 1)
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
$$;

-- Was EIN Stück eines Angebots verbraucht: bei auftragsgefertigten Artikeln
-- die Teile der Stückliste (eine Ebene, wie baubar()), sonst der Artikel
-- selbst.
create or replace function shop_bedarf(p_variant uuid) returns table(komponente uuid, je numeric)
language plpgsql stable set search_path to 'public', 'pg_temp' as $$
declare
  v_bom boms%rowtype;
  v_produkt_uom uuid;
  v_bom_menge numeric;
begin
  if not ist_made_to_order(p_variant) then
    return query select p_variant, 1::numeric;
    return;
  end if;
  select * into v_bom from boms where id = resolve_bom(p_variant);
  select pt.uom_id into v_produkt_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = p_variant;
  v_bom_menge := uom_convert(v_bom.qty, v_bom.uom_id, v_produkt_uom);
  if coalesce(v_bom_menge, 0) <= 0 then
    return;
  end if;
  return query
    select k.component_variant_id, sum(uom_convert(k.qty, k.uom_id, pt.uom_id) / v_bom_menge)
    from bom_components_for_variant(v_bom.id, p_variant) k
    join product_variants pv on pv.id = k.component_variant_id
    join product_templates pt on pt.id = pv.template_id
    where pt.type = 'goods' and k.qty > 0
    group by k.component_variant_id
    having sum(uom_convert(k.qty, k.uom_id, pt.uom_id) / v_bom_menge) > 0;
end $$;

-- Was von einem Teil für den Shop verteilbar ist: frei nach den Shop-Regeln
-- (shop_frei), plus was sich aus eigener Stückliste nachbauen ließe.
create or replace function shop_pool(p_komponente uuid) returns numeric
language sql stable set search_path to 'public', 'pg_temp' as $$
  select greatest(shop_frei(p_komponente), 0)
       + case when resolve_bom(p_komponente) is not null and not ist_made_to_order(p_komponente)
              then coalesce((select b.menge from baubar(p_komponente, 1, true) b), 0) else 0 end;
$$;

-- Teile, die schon vergeben sind, ohne reserviert zu sein: Shop-Bestellungen
-- im Entwurf (Klärfall offen). Der Shop hat sie heruntergezählt, KRNL hat
-- noch nichts reserviert — der Pool muss sie trotzdem abziehen.
create or replace function shop_entwurf_bedarf() returns table(komponente uuid, menge numeric)
language sql stable set search_path to 'public', 'pg_temp' as $$
  select b.komponente, sum(l.qty * b.je)
  from sales_orders so
  join sales_order_lines l on l.order_id = so.id and l.variant_id is not null
  cross join lateral shop_bedarf(l.variant_id) b
  where so.state = 'draft' and so.source = 'shopify'
  group by b.komponente;
$$;

-- Eine Bestellung gegen das Buch zählen (Menge negativ = Storno). Nur für
-- Angebote, deren Buch läuft, und nur für Bestellungen, die nach der
-- letzten absoluten Meldung angelegt wurden (fünf Sekunden Abstand gegen
-- abweichende Uhren — im Zweifel zählt eine Bestellung NICHT, dann zeigt
-- der Shop eher zu wenig als zu viel).
create or replace function shop_buch_bestellung(p_variant_gid text, p_menge numeric, p_zeit timestamptz)
returns void language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if p_variant_gid is null or coalesce(p_menge, 0) = 0 then return; end if;
  update shopify_inventory_state s
     set pushed_qty = s.pushed_qty - p_menge
    from product_variants v
   where v.id = s.variant_id and v.shopify_variant_id = p_variant_gid
     and s.pushed_qty is not null and s.buch_ab is not null
     and p_zeit > s.buch_ab + interval '5 seconds';
  update shopify_zweitangebote z
     set pushed_qty = z.pushed_qty - p_menge
   where z.shopify_variant_id = p_variant_gid
     and z.pushed_qty is not null and z.buch_ab is not null
     and p_zeit > z.buch_ab + interval '5 seconds'
     and not exists (select 1 from product_variants x where x.shopify_variant_id = z.shopify_variant_id);
end $$;

-- Telegram-Art für den Überverkaufs-Wächter (S5) und Abweichungen (S7).
-- DESTRUKTIV: Check-Constraint benachrichtigungen_art_check wird nur um 'ueberverkauf' erweitert — keine Zeile geht verloren.
alter table benachrichtigungen drop constraint benachrichtigungen_art_check;
alter table benachrichtigungen add constraint benachrichtigungen_art_check
  check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test', 'einkauf', 'zulauf', 'sicherheit', 'ueberverkauf'));
