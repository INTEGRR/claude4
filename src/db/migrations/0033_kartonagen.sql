-- ===========================================================================
-- Kartonagen: Verpackung wählen, Gewicht mitrechnen, Verbrauch buchen
-- ===========================================================================
--
-- Bisher war das Sendungsgewicht das reine Warengewicht — der Karton fiel
-- unter den Tisch. An der Kleinpaket-Grenze ist das der Unterschied zwischen
-- angenommen und abgelehnt (980 g Ware + 60 g Karton = 1040 g). Und
-- Verpackungsmaterial ist Ware wie jede andere: es wird eingekauft, liegt im
-- Regal und geht zur Neige.
--
-- Deshalb ist eine Kartonage hier kein Stammdatensatz neben dem Lager,
-- sondern ein **Produkt mit Zusatzangaben**. Bestand, Einkaufspreis,
-- Leergewicht und Meldebestand kommen damit aus dem bestehenden Modell; neu
-- sind nur Fassungsvermögen und Kleinpaket-Tauglichkeit.
--
-- ## Platzbedarf: eine Skala für alles
--
-- Bisher stand am Produkt „Stück je Kleinpaket". Das beantwortet aber nur
-- die Kleinpaket-Frage und sagt nichts über größere Kartons — und für
-- Produkte, die gar nicht ins Kleinpaket passen (Tastatur), ist die Zahl
-- sinnlos. Ersetzt wird sie durch den **Platzbedarf** in derselben Einheit
-- für alle: 1 = ein volles Kleinpaket (35,5 x 25 x 8 cm).
--
--   Keycap-Set  0,5   (zwei passen ins Kleinpaket)
--   Kabel       0,1   (zehn passen hinein)
--   Tastatur    3     (braucht das Dreifache)
--
-- Kartonagen tragen ihr Fassungsvermögen in derselben Skala. Damit ist
-- „passt ins Kleinpaket" nur noch der Sonderfall „passt in eine Kartonage,
-- die als Kleinpaket verschickt werden darf".

-- Umrechnung: aus „n Stück je Kleinpaket" wird „1/n Platz je Stück".
alter table product_templates add column platzbedarf numeric(8,3) not null default 1
  check (platzbedarf > 0);
update product_templates set platzbedarf = round(1.0 / greatest(kleinpaket_max_qty, 1), 3);
alter table product_templates drop column kleinpaket_max_qty;

comment on column product_templates.platzbedarf is
  'Platzbedarf eines Stücks; 1 = ein volles DHL Kleinpaket (35,5 x 25 x 8 cm).';

create table packagings (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Der Bestandsartikel. Daher kommen Leergewicht (weight_g), Wert und
  -- Bestand; ohne ihn gäbe es keinen Verbrauch zu buchen.
  variant_id  uuid not null references product_variants on delete restrict,
  capacity    numeric(8,3) not null check (capacity > 0),
  max_content_g integer not null check (max_content_g > 0),
  -- Darf eine Sendung in dieser Kartonage als Kleinpaket laufen?
  kleinpaket  boolean not null default false,
  sequence    integer not null default 10,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('packagings');
create index packagings_wahl_idx on packagings (sequence, capacity) where active;

comment on table packagings is
  'Verpackungen als Bestandsartikel: Fassungsvermögen in Platz-Einheiten '
  '(1 = ein Kleinpaket), Höchstgewicht des Inhalts, Kleinpaket-Tauglichkeit.';

alter table shipments
  add column packaging_id      uuid references packagings on delete set null,
  add column packaging_move_id uuid references stock_moves on delete set null;

comment on column shipments.packaging_move_id is
  'Bestandsbewegung des Verbrauchs — gesetzt beim Warenausgang, nicht beim '
  'Etikettieren: ein storniertes Label verbraucht keinen Karton.';

/*
 * Verbrauch einer Kartonage buchen.
 *
 * Aufgerufen nach der Validierung der Lieferung: der Karton verlässt das
 * Haus zusammen mit der Ware, also geht er auch buchhalterisch denselben Weg
 * (Lagerort der Lieferung -> Kunden). Damit bleibt die Grundregel gewahrt —
 * jede Bestandsänderung ist eine Bewegung.
 *
 * Bewusst idempotent: ein zweiter Aufruf (Wiederholung, Nachlauf eines Jobs)
 * bucht nicht doppelt.
 */
create or replace function packaging_consume(p_shipment uuid) returns uuid
language plpgsql as $$
declare
  s            shipments%rowtype;
  v_variant    uuid;
  v_uom        uuid;
  v_src        uuid;
  v_dest       uuid;
  v_move_src   uuid;
  v_move_dest  uuid;
  v_move       uuid;
  v_number     text;
begin
  select * into s from shipments where id = p_shipment;
  if not found then raise exception 'Sendung nicht gefunden'; end if;
  if s.packaging_id is null then return null; end if;
  if s.packaging_move_id is not null then return s.packaging_move_id; end if;

  select p.variant_id into v_variant from packagings p where p.id = s.packaging_id;

  select pt.uom_id into v_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = v_variant;

  -- Wege der Lieferung übernehmen; die Vorgaben der Vorgangsart sind die
  -- Rückfallebene, falls die Lieferung keine erledigte Bewegung hat.
  -- Getrennte Variablen, weil ein SELECT INTO ohne Treffer die Ziele auf
  -- NULL setzt und die Rückfallebene sonst wieder zunichtemachen würde.
  select p.number, ot.default_src_id, ot.default_dest_id
    into v_number, v_src, v_dest
  from stock_pickings p
  join operation_types ot on ot.id = p.operation_type_id
  where p.id = s.picking_id;

  select m.src_location_id, m.dest_location_id into v_move_src, v_move_dest
  from stock_moves m
  where m.picking_id = s.picking_id and m.state = 'done'
  limit 1;

  if v_move_src is not null and v_move_dest is not null then
    v_src := v_move_src;
    v_dest := v_move_dest;
  end if;

  if v_src is null or v_dest is null then
    raise exception 'Für die Lieferung % sind keine Lagerorte bestimmbar', v_number;
  end if;

  insert into stock_moves (variant_id, uom_id, qty, src_location_id, dest_location_id,
                           state, reference)
  values (v_variant, v_uom, 1, v_src, v_dest, 'confirmed',
          'Kartonage zu ' || coalesce(v_number, 'Lieferung'))
  returning id into v_move;

  perform move_done(v_move);
  update shipments set packaging_move_id = v_move where id = p_shipment;
  return v_move;
end $$;

comment on function packaging_consume is
  'Bucht eine Kartonage als Verbrauch zur Sendung (idempotent).';
