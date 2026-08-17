-- Befugnisse + Bestellfreigabe: Rechte auf Prozessschritte, personengebunden.
--
-- Die Bereichsmatrix (Rolle → Bereiche) bleibt der Sicherheitsboden; NEU sind
-- BEFUGNISSE am Benutzer (z. B. 'einkauf:freigabe') als feineres, personen-
-- gebundenes Recht. Prozessschritte können neben Rollen eine Befugnis
-- verlangen — der Torwächter erzwingt beides hart, egal ob der Aufruf vom
-- Knopf, von /api/aktion oder aus dem KI-Chat kommt (Admin besteht immer).
--
-- Pilot: Freigabe von Bestellungen. Das Limit ist eine EINSTELLUNG
-- (settings 'freigaben' → einkauf_limit, netto; leer = keine
-- Freigabepflicht) — nichts ist hartkodiert. Der Riegel sitzt als Trigger
-- an der Statusmaschine selbst: ohne Freigabe wird über dem Limit nicht
-- bestätigt, auf keinem Weg. Positionsänderungen lassen eine erteilte
-- Freigabe erlöschen — freigegeben wurde eine Summe, nicht ein Beleg.

alter table users
  add column befugnisse text[] not null default '{}';

comment on column users.befugnisse is
  'Personengebundene Zusatzrechte (z. B. einkauf:freigabe) — von Prozessschritten verlangt, vom Torwächter geprüft. Ergänzt die Rollenmatrix, ersetzt sie nicht.';

alter table purchase_orders
  add column freigegeben_von text,
  add column freigegeben_am  timestamptz;

alter table prozess_schritte  add column befugnis text;
alter table prozess_overrides add column befugnis text;

comment on column prozess_schritte.befugnis is
  'Verlangte Benutzer-Befugnis für diesen Schritt (zusätzlich zu rollen); null = keine. Overrides können sie je Firma ändern.';

-- Einstellung anlegen (leer = Freigabepflicht aus). Der Wert wird auf
-- /einstellungen gepflegt, nie im Code festgelegt.
insert into settings (key, value) values ('freigaben', '{}'::jsonb)
on conflict (key) do nothing;

-- Versionskopie nimmt die neue Schrittspalte mit — sonst verlöre jede neue
-- Prozessversion die Rechteanforderung stillschweigend.
create or replace function prozess_version_kopieren(p_code text, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  v_prozess uuid;
  v_alt uuid;
  v_neu uuid;
  v_nr int;
begin
  select id into v_prozess from prozesse where code = p_code;
  if v_prozess is null then raise exception 'Unbekannter Prozess: %', p_code; end if;
  v_alt := prozess_aktive_version(p_code);
  if v_alt is null then raise exception 'Prozess % hat keine aktive Version', p_code; end if;

  select coalesce(max(version), 0) + 1 into v_nr
  from prozess_versionen where prozess_id = v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, v_nr, 'entwurf', p_actor)
  returning id into v_neu;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, job_kind,
                                ereignis, matching_tabelle, matching_bedingung,
                                teilprozess, teilprozess_link, zustand,
                                rollen, befugnis, params, optional)
  select v_neu, code, name, art, sequence, aktion, job_kind,
         ereignis, matching_tabelle, matching_bedingung,
         teilprozess, teilprozess_link, zustand,
         rollen, befugnis, params, optional
  from prozess_schritte where version_id = v_alt;

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  select v_neu, von_code, nach_code, sequence, bedingung, beschriftung
  from prozess_uebergaenge where version_id = v_alt;

  return v_neu;
end $$;

-- --- Freigabe-Logik ---------------------------------------------------------

-- Braucht die Bestellung (noch) eine Freigabe? Limit aus den Einstellungen,
-- Summe netto. Ohne gesetztes Limit: nie.
create or replace function einkauf_freigabe_noetig(p_order uuid)
returns boolean
language sql stable as $$
  select coalesce(
    (select t.net >= (s.value ->> 'einkauf_limit')::numeric
     from settings s
     cross join lateral purchase_order_total(p_order) t
     where s.key = 'freigaben' and s.value ->> 'einkauf_limit' is not null),
    false)
  and exists (select 1 from purchase_orders po
              where po.id = p_order and po.freigegeben_am is null);
$$;

comment on function einkauf_freigabe_noetig is
  'true, wenn das Freigabe-Limit (settings freigaben.einkauf_limit, netto) gesetzt und erreicht ist und noch keine Freigabe vorliegt.';

-- Freigeben: nur offene Bestellungen, nur einmal. Wer freigeben darf,
-- entscheidet der Torwächter über die Schritt-Befugnis — hier steht nur,
-- WAS die Freigabe fachlich bedeutet.
create or replace function purchase_order_approve(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  o record;
begin
  select po.*, t.net into o
  from purchase_orders po
  cross join lateral purchase_order_total(po.id) t
  where po.id = p_order;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state not in ('draft', 'sent') then
    raise exception 'Nur offene Bestellungen (Entwurf/Angefragt) lassen sich freigeben';
  end if;
  if o.freigegeben_am is not null then
    raise exception 'Bereits freigegeben von % am %', o.freigegeben_von, o.freigegeben_am::date;
  end if;

  update purchase_orders
  set freigegeben_von = p_actor, freigegeben_am = now()
  where id = p_order;
  perform log_event('purchase_order', p_order, 'state',
    format('Bestellung freigegeben (Summe %s € netto)', round(o.net, 2)), p_actor);
end $$;

-- Der harte Riegel sitzt an der Statusmaschine: draft/sent → purchase geht
-- über dem Limit nur mit vorliegender Freigabe — egal auf welchem Weg.
create or replace function purchase_order_freigabe_guard()
returns trigger
language plpgsql as $$
declare
  v_limit numeric;
  v_net numeric;
begin
  select (value ->> 'einkauf_limit')::numeric into v_limit
  from settings where key = 'freigaben';
  if v_limit is null then return new; end if;
  if new.freigegeben_am is not null then return new; end if;

  select net into v_net from purchase_order_total(new.id);
  if v_net >= v_limit then
    raise exception
      'Freigabe erforderlich: Bestellsumme % € netto liegt über dem Limit von % € — erst freigeben lassen (Befugnis „Bestellungen freigeben"), dann bestellen',
      round(v_net, 2), v_limit;
  end if;
  return new;
end $$;

create trigger purchase_order_freigabe
before update of state on purchase_orders
for each row
when (old.state in ('draft', 'sent') and new.state = 'purchase')
execute function purchase_order_freigabe_guard();

-- Freigegeben wurde eine SUMME: ändern sich die Positionen einer offenen
-- Bestellung, erlischt die Freigabe (mit Spur im Verlauf).
create or replace function purchase_order_freigabe_reset()
returns trigger
language plpgsql as $$
declare
  v_order uuid;
  v_state text;
  v_von text;
begin
  v_order := coalesce(new.order_id, old.order_id);
  select state, freigegeben_von into v_state, v_von
  from purchase_orders where id = v_order;
  if v_state in ('draft', 'sent') and v_von is not null then
    update purchase_orders
    set freigegeben_von = null, freigegeben_am = null
    where id = v_order;
    perform log_event('purchase_order', v_order, 'note',
      format('Positionen geändert — die Freigabe von %s ist erloschen', v_von), 'system');
  end if;
  return coalesce(new, old);
end $$;

create trigger purchase_order_freigabe_reset
after insert or delete or update of qty, price_unit, discount
on purchase_order_lines
for each row execute function purchase_order_freigabe_reset();

-- --- Einkaufsprozess V5: Freigabe als sichtbarer, konfigurierbarer Schritt --
-- Optional (unter dem Limit überspringbar; der Trigger oben erzwingt sie
-- über dem Limit) und an die Befugnis 'einkauf:freigabe' gebunden — wer sie
-- ausführen darf, steht damit im Prozess, nicht im Code.

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkauf_wareneingang_rechnung', 'migration:0056');

  insert into prozess_schritte (version_id, code, name, art, sequence,
                                aktion, befugnis, optional)
  values (v_neu, 'freigeben', 'Bestellung freigeben', 'aktion', 25,
          'einkauf.bestellung_freigeben', 'einkauf:freigabe', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence)
  values
    (v_neu, 'anlegen',    'freigeben',   30),
    (v_neu, 'beschaffen', 'freigeben',   30),
    (v_neu, 'position',   'freigeben',   15),
    (v_neu, 'freigeben',  'bestaetigen', 10);

  perform prozess_version_aktivieren(v_neu);
end $$;
