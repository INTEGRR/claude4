-- ============================================================================
-- 0125 — Retoure: Restmenge auch innerhalb eines Aufrufs prüfen (UX-Audit)
--
-- retoure_anlegen ließ die eigene, gerade entstehende Retoure aus der Summe
-- „schon in Retouren" heraus — dieselbe Auftragszeile zweimal im selben
-- Aufruf (API/JSON) überstieg so die Liefermenge. Jetzt zählen die schon
-- erfassten eigenen Zeilen mit.
--
--  * retoure_anlegen (voller Körper aus 0119), nur die Summe geändert
--  * retoure_restmenge(auftrag): noch rücksendbare Menge über alle Zeilen —
--    der Knopf „Retoure anlegen" am Auftrag erscheint nur, wenn sie > 0 ist
-- ============================================================================

create or replace function retoure_restmenge(p_order uuid) returns numeric
language sql stable as $$
  select coalesce(sum(greatest(sol.qty_delivered - coalesce((
           select sum(rp.menge) from retoure_positionen rp
           join retouren r on r.id = rp.retoure_id
           where rp.sales_order_line_id = sol.id and r.status not in ('abgelehnt', 'storniert')), 0), 0)), 0)
  from sales_order_lines sol
  where sol.order_id = p_order and sol.variant_id is not null
$$;

create or replace function retoure_anlegen(
  p_order uuid, p_positionen jsonb, p_quelle text default 'intern', p_grund text default null,
  p_email text default null, p_absender_hash text default null, p_actor text default 'system'
) returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  o       sales_orders%rowtype;
  v_id    uuid;
  v_nr    text;
  v_seq   int := 10;
  v_frei  numeric;
  p       jsonb;
  l       record;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Auftrag nicht gefunden'; end if;
  if o.source <> 'shopify' then raise exception 'Retouren gibt es nur für Shop-Aufträge'; end if;
  if jsonb_typeof(p_positionen) <> 'array' or jsonb_array_length(p_positionen) = 0 then
    raise exception 'Bitte mindestens eine Position mit Menge angeben';
  end if;

  v_nr := next_sequence('retoure');
  insert into retouren (nummer, sales_order_id, partner_id, quelle, email, grund, absender_hash, shop_brutto_vorher)
  values (v_nr, o.id, o.partner_id, coalesce(p_quelle, 'intern'), nullif(trim(coalesce(p_email, '')), ''),
          nullif(trim(coalesce(p_grund, '')), ''), p_absender_hash, o.shopify_brutto)
  returning id into v_id;

  for p in select * from jsonb_array_elements(p_positionen) loop
    continue when coalesce((p ->> 'menge')::numeric, 0) <= 0;
    select sol.id, sol.variant_id, sol.name, sol.qty_delivered,
           coalesce((select sum(rp.menge) from retoure_positionen rp
                     join retouren r on r.id = rp.retoure_id
                     -- 0125: auch die eigenen, schon erfassten Zeilen zählen (doppelte Zeile im selben Aufruf)
                     where rp.sales_order_line_id = sol.id
                       and r.status not in ('abgelehnt', 'storniert')), 0) as schon
      into l
    from sales_order_lines sol
    where sol.id = (p ->> 'zeile')::uuid and sol.order_id = o.id and sol.variant_id is not null;
    if l.id is null then raise exception 'Position gehört nicht zum Auftrag %', o.number; end if;
    v_frei := l.qty_delivered - l.schon;
    if (p ->> 'menge')::numeric > v_frei then
      raise exception '%: höchstens % zurücksendbar (geliefert %, schon in Retouren %)',
        l.name, trim_scale(greatest(v_frei, 0)), trim_scale(l.qty_delivered), trim_scale(l.schon);
    end if;
    insert into retoure_positionen (retoure_id, sequence, sales_order_line_id, variant_id, bezeichnung, menge, grund)
    values (v_id, v_seq, l.id, l.variant_id, l.name, (p ->> 'menge')::numeric, nullif(trim(coalesce(p ->> 'grund', '')), ''));
    v_seq := v_seq + 10;
  end loop;

  if v_seq = 10 then raise exception 'Bitte mindestens eine Position mit Menge angeben'; end if;
  perform log_event('retoure', v_id, 'state',
    format('Retoure %s angefragt (%s)', v_nr, case coalesce(p_quelle, 'intern') when 'shop' then 'Portal im Shop' else 'intern' end), p_actor);
  perform log_event('sales_order', o.id, 'note', format('Retoure %s angefragt', v_nr), p_actor);
  return v_id;
end $$;
