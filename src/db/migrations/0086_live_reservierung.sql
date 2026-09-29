-- ============================================================================
-- 0086  Live-Reservierung: frei gewordene Ware erreicht wartende Bewegungen
-- ----------------------------------------------------------------------------
-- Gefunden im Parallelbetrieb (2026-09-29): Aufträge wurden bei Bestand 0
-- bestätigt, ihre Lieferungen warteten auf Ware. Eine spätere Inventur buchte
-- Ware ein — die Lieferungen blieben trotzdem auf „wartet" und erschienen nie
-- im Versand. Reserviert wurde nur beim Bestätigen, per „Verfügbarkeit
-- prüfen" und nach der Fertigmeldung; jeder andere Weg ließ den Status
-- veralten.
--
-- Jetzt: Wird an einem internen Ort Ware frei — Bestand rauf (Inventur,
-- Wareneingang, Fertigmeldung, Retoure) oder Reservierung runter (Storno) —,
-- reserviert die Datenbank sofort die wartenden Bewegungen desselben
-- Artikels an diesem Ort: Transfers mit Reservierung „bei Bestätigung"
-- (Lieferungen) und Komponenten laufender Fertigungsaufträge, ältester Termin
-- zuerst; reicht die Ware nicht, gilt die übliche Teilreservierung.
--
-- Constraint-Trigger, INITIALLY DEFERRED: er läuft am Ende der Transaktion.
-- Ausdrückliche Reservierungen derselben Buchung behalten so Vorrang — die
-- Fertigmeldung reserviert zuerst die Lieferung IHRES Auftrags, erst der Rest
-- geht an die Warteschlange. Keine Rekursion: das Reservieren verringert den
-- freien Bestand, der Trigger bricht dann sofort ab.
--
-- Am Ende ein einmaliger Nachlauf für alles, was heute schon wartet.
-- Entscheidungslog 2026-09-29.
-- ============================================================================

-- Fester search_path wie alle eigenen Funktionen (0080).
create or replace function wartende_bewegungen_reservieren(p_variant uuid, p_location uuid)
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  m record;
  v_frei numeric;
  v_reserviert int := 0;
  v_transfers uuid[] := '{}';
  v_id uuid;
begin
  for m in
    select sm.id, sm.picking_id
    from stock_moves sm
    left join stock_pickings p on p.id = sm.picking_id
    left join operation_types ot on ot.id = p.operation_type_id
    left join manufacturing_orders mo on mo.id = sm.production_id
    where sm.variant_id = p_variant
      and sm.src_location_id = p_location
      and sm.state = 'confirmed'
      and (
        (sm.picking_id is not null and ot.reservation = 'at_confirm'
          and p.state in ('waiting', 'confirmed', 'assigned'))
        or (sm.production_id is not null and mo.state in ('confirmed', 'progress'))
      )
    order by coalesce(p.scheduled_date, mo.scheduled_date),
             coalesce(p.created_at, mo.created_at), sm.id
  loop
    select q.on_hand - q.reserved into v_frei
    from stock_quants q where q.location_id = p_location and q.variant_id = p_variant;
    exit when coalesce(v_frei, 0) <= 0;

    perform move_reserve(m.id);
    v_reserviert := v_reserviert + 1;
    if m.picking_id is not null and not (m.picking_id = any(v_transfers)) then
      v_transfers := v_transfers || m.picking_id;
    end if;
  end loop;

  foreach v_id in array v_transfers loop
    perform picking_recompute_state(v_id);
  end loop;
  return v_reserviert;
end $$;

comment on function wartende_bewegungen_reservieren(uuid, uuid) is
  'Reserviert wartende Bewegungen (Transfers at_confirm, Fertigungskomponenten) eines Artikels an einem Ort, ältester Termin zuerst; Rückgabe: Anzahl bedienter Bewegungen';

create or replace function stock_quants_nachreservieren() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  -- Nur wenn an diesem Ort Ware frei geworden ist …
  if tg_op = 'UPDATE' and (new.on_hand - new.reserved) <= (old.on_hand - old.reserved) then
    return null;
  end if;
  if (new.on_hand - new.reserved) <= 0 then
    return null;
  end if;
  -- … und nur an internen Orten (virtuelle Orte haben nichts zu reservieren).
  if not exists (select 1 from stock_locations where id = new.location_id and type = 'internal') then
    return null;
  end if;
  perform wartende_bewegungen_reservieren(new.variant_id, new.location_id);
  return null;
end $$;

create constraint trigger stock_quants_nachreservieren
  after insert or update of on_hand, reserved on stock_quants
  deferrable initially deferred
  for each row execute function stock_quants_nachreservieren();

-- Einmaliger Nachlauf: was heute schon wartet und Ware hätte, bekommt sie.
select wartende_bewegungen_reservieren(q.variant_id, q.location_id)
from stock_quants q
join stock_locations l on l.id = q.location_id
where l.type = 'internal'
  and q.on_hand - q.reserved > 0
  and exists (
    select 1 from stock_moves sm
    where sm.variant_id = q.variant_id and sm.src_location_id = q.location_id
      and sm.state = 'confirmed');
