-- Komponierte Prozesse (Engine-Erweiterung) — drei BPMN-Konzepte im
-- Beleg-als-Token-Modell, ohne Token-Engine:
--
--  * MEHRFACH-STARTS: ein Prozess darf mehrere Einstiege haben (z. B.
--    Einkauf: „Meldebestand erreicht" UND „manueller Bedarf"). Die
--    Validierung verlangt nur noch MINDESTENS einen Start; erreichbar
--    sein muss jeder Schritt von irgendeinem Start aus.
--  * TEILPROZESSE (Call Activity): Schrittart 'prozess' verweist auf einen
--    Kindprozess. Der Kindbeleg hängt über die Beleg-Herkunft am
--    Elternbeleg (origin_model/origin_id) oder über eine Fremdschlüssel-
--    Spalte (teilprozess_link {"spalte": "purchase_order_id"}). Solange
--    der Teilprozess läuft, wird der Schritt wartend angeboten; sind alle
--    Kindbelege am Ende, rücken die Nachfolger nach.
--  * BELEG-FILTER: mehrere Prozesse je Belegart (prozesse.beleg_filter,
--    Bedingungssprache) — Eingangs-Transfers gehören dem Wareneingang,
--    Ausgangs-Transfers dem Shop-Versand. prozess_fuer_beleg() wählt.
--
-- Die Seeds (Einkauf als Pilot) folgen in 0050: ein neuer Enum-Wert darf
-- in derselben Transaktion nicht in Zeilen verwendet werden.

alter type prozess_schritt_art add value if not exists 'prozess' before 'xor';

alter table prozess_schritte
  add column teilprozess text,
  add column teilprozess_link jsonb;
comment on column prozess_schritte.teilprozess is
  'art = prozess: Code des Kindprozesses (Call Activity)';
comment on column prozess_schritte.teilprozess_link is
  'Kindbeleg-Verknüpfung: null = origin_model/origin_id zeigt auf den Elternbeleg; {"spalte": "…"} = Fremdschlüsselspalte der Kindtabelle';

alter table prozesse add column beleg_filter jsonb;
comment on column prozesse.beleg_filter is
  'Welche Belege des Modells dieser Prozess führt (Bedingungssprache); null = alle. Erlaubt mehrere Prozesse je Belegart.';

-- Die Art-Verknüpfungs-Prüfung um 'prozess' erweitern. Über art::text,
-- damit der frisch angelegte Enum-Wert nicht in derselben Transaktion als
-- Literal auftauchen muss.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'prozess_schritte'::regclass and contype = 'c';
  if v_name is not null then
    execute format('alter table prozess_schritte drop constraint %I', v_name);
  end if;
end $$;

alter table prozess_schritte add constraint prozess_schritte_art_check check (
  case art::text
    when 'aktion'   then aktion is not null
    when 'dienst'   then job_kind is not null
    when 'ereignis' then ereignis is not null
    when 'matching' then matching_tabelle is not null and aktion is not null
    when 'prozess'  then teilprozess is not null
    else true
  end
);

-- --- Teilprozess-Stand -------------------------------------------------------

/*
 * Wie weit ist der Teilprozess eines Elternbelegs? Kindbelege werden über
 * die Herkunft (origin_model/origin_id) oder die Link-Spalte gefunden;
 * „fertig" heißt: der Kindprozess bietet für den Beleg nichts mehr an
 * (dieselbe Semantik wie danachKeineSchritte im Prozesstest).
 */
create or replace function teilprozess_stand(
  p_teilprozess text, p_link jsonb, p_parent_modell text, p_parent uuid
) returns table (gesamt int, fertig int, letzter_beleg uuid)
language plpgsql stable as $$
declare
  v_modell text;
  v_tabelle text;
  v_ids uuid[];
  v_id uuid;
  v_fertig int := 0;
begin
  gesamt := 0; fertig := 0; letzter_beleg := null;
  if p_parent is null then return next; return; end if;

  select p.modell into v_modell from prozesse p where p.code = p_teilprozess;
  if v_modell is null then return next; return; end if;
  select m.tabelle into v_tabelle from prozess_modelle m where m.modell = v_modell;
  if v_tabelle is null then return next; return; end if;

  if p_link ? 'spalte' then
    execute format('select array_agg(id order by created_at) from %I where %I = $1',
                   v_tabelle, p_link ->> 'spalte')
      using p_parent into v_ids;
  else
    execute format(
      'select array_agg(id order by created_at) from %I where origin_model = $1 and origin_id = $2',
      v_tabelle)
      using p_parent_modell, p_parent into v_ids;
  end if;

  gesamt := coalesce(array_length(v_ids, 1), 0);
  if gesamt = 0 then return next; return; end if;

  foreach v_id in array v_ids loop
    if not exists (select 1 from prozess_naechste_schritte(p_teilprozess, v_id)) then
      v_fertig := v_fertig + 1;
    end if;
    letzter_beleg := v_id;
  end loop;
  fertig := v_fertig;
  return next;
end $$;

-- --- Prozesswahl je Beleg ----------------------------------------------------

/* Welcher aktive Prozess führt diesen Beleg? Spezifische Filter gewinnen. */
create or replace function prozess_fuer_beleg(p_modell text, p_beleg uuid)
returns text
language plpgsql stable as $$
declare
  v_daten jsonb := prozess_beleg_daten(p_modell, p_beleg);
  r record;
begin
  for r in
    select p.code, p.beleg_filter from prozesse p
    where p.aktiv and p.modell = p_modell
    order by (p.beleg_filter is not null) desc, p.code
  loop
    if r.beleg_filter is null or bedingung_pruefen(v_daten, r.beleg_filter) then
      return r.code;
    end if;
  end loop;
  return null;
end $$;

-- --- prozess_naechste_schritte: Teilprozess-Schritte -------------------------

create or replace function prozess_naechste_schritte(p_code text, p_record uuid)
returns table (
  code text, name text, art prozess_schritt_art,
  aktion text, job_kind text, ereignis text,
  rollen text[], params jsonb, optional boolean
)
language plpgsql stable as $$
declare
  v_version uuid := prozess_aktive_version(p_code);
  v_modell text;
  v_daten jsonb := '{}'::jsonb;
  v_aktuell text;
  kante record;
  ziel prozess_schritte%rowtype;
  ov prozess_overrides%rowtype;
  warteschlange text[];
  besucht text[] := '{}';
  geliefert text[] := '{}';
  v_gesamt int; v_fertig int; v_beleg uuid;
begin
  if v_version is null then return; end if;

  select p.modell into v_modell from prozesse p where p.code = p_code;
  if p_record is not null then
    if v_modell is not null then
      v_daten := prozess_beleg_daten(v_modell, p_record);
    else
      select i.daten into v_daten from prozess_instanzen i where i.id = p_record;
    end if;
  end if;

  v_aktuell := case
    when p_record is null then null
    else prozess_aktueller_schritt(p_code, p_record)
  end;
  -- Ohne Standort (neuer Beleg / Prozessstart): ab ALLEN Startknoten —
  -- Mehrfach-Starts bieten jeden Einstieg an.
  if v_aktuell is null then
    warteschlange := array(
      select s.code from prozess_schritte s
      where s.version_id = v_version and s.art = 'start' order by s.sequence);
    if coalesce(array_length(warteschlange, 1), 0) = 0 then return; end if;
  else
    warteschlange := array[v_aktuell];
  end if;

  while array_length(warteschlange, 1) > 0 loop
    v_aktuell := warteschlange[1];
    warteschlange := warteschlange[2:];
    if v_aktuell = any(besucht) then continue; end if;
    besucht := besucht || v_aktuell;

    for kante in
      select u.* from prozess_uebergaenge u
      where u.version_id = v_version and u.von_code = v_aktuell
      order by u.sequence
    loop
      if not bedingung_pruefen(v_daten, kante.bedingung) then continue; end if;

      select s.* into ziel from prozess_schritte s
      where s.version_id = v_version and s.code = kante.nach_code;

      -- Override anwenden (bindet an Codes, nicht an Versionen).
      select o.* into ov from prozess_overrides o
      where o.prozess_code = p_code and o.schritt_code = ziel.code;

      if ziel.art = 'xor'
         or (ov.aktiv is false and ziel.optional) then
        -- Durchgangsstation bzw. abgeschalteter optionaler Schritt:
        -- die Nachfolger rücken nach.
        warteschlange := warteschlange || ziel.code;
        continue;
      end if;

      -- Teilprozess: fertig (alle Kindbelege am Ende) → Nachfolger rücken
      -- nach; sonst wird der Schritt wartend angeboten.
      if ziel.art = 'prozess' then
        select t.gesamt, t.fertig into v_gesamt, v_fertig
        from teilprozess_stand(ziel.teilprozess, ziel.teilprozess_link, v_modell, p_record) t;
        if v_gesamt > 0 and v_fertig = v_gesamt then
          warteschlange := warteschlange || ziel.code;
          continue;
        end if;
      end if;

      if ziel.art in ('start', 'ende') then continue; end if;

      -- Über zwei Wege erreichbar (direkt UND über einen übersprungenen
      -- optionalen Schritt): nur einmal anbieten.
      if ziel.code = any(geliefert) then continue; end if;
      geliefert := geliefert || ziel.code;

      code     := ziel.code;
      name     := ziel.name;
      art      := ziel.art;
      aktion   := ziel.aktion;
      job_kind := ziel.job_kind;
      ereignis := ziel.ereignis;
      rollen   := ziel.rollen;
      params   := ziel.params;
      optional := ziel.optional;
      return next;
    end loop;
  end loop;
end $$;

-- --- Validierung: Mehrfach-Starts + Teilprozess-Verweise ---------------------

create or replace function prozess_version_aktivieren(p_version uuid)
returns void
language plpgsql as $$
declare
  v_prozess uuid;
  v_code text;
  v_start int;
  v_ende int;
  gesamt int;
  erreicht text[];
  rest int;
  neu text[];
  r record;
begin
  select v.prozess_id, p.code into v_prozess, v_code
  from prozess_versionen v join prozesse p on p.id = v.prozess_id
  where v.id = p_version;
  if v_prozess is null then raise exception 'Unbekannte Version'; end if;

  select count(*) filter (where art = 'start'),
         count(*) filter (where art = 'ende'),
         count(*)
    into v_start, v_ende, gesamt
  from prozess_schritte where version_id = p_version;

  -- Mehrfach-Starts sind erlaubt (mehrere Einstiege, z. B. Meldebestand
  -- UND manueller Bedarf) — nur ganz ohne Start geht es nicht.
  if v_start < 1 then raise exception 'Ein Prozess braucht mindestens einen Startschritt'; end if;
  if v_ende < 1 then raise exception 'Ein Prozess braucht mindestens einen Endschritt'; end if;

  -- Teilprozess-Verweise: der Kindprozess muss existieren und darf nicht
  -- der eigene sein (direkte Rekursion wäre eine Schleife).
  for r in
    select s.code, s.teilprozess from prozess_schritte s
    where s.version_id = p_version and s.art = 'prozess'
  loop
    if r.teilprozess = v_code then
      raise exception 'Teilprozess-Schritt „%" verweist auf den eigenen Prozess', r.code;
    end if;
    if not exists (select 1 from prozesse p where p.code = r.teilprozess) then
      raise exception 'Teilprozess-Schritt „%": Prozess „%" existiert nicht', r.code, r.teilprozess;
    end if;
  end loop;

  -- Kanten müssen auf existierende Schritte zeigen (FK deckt das ab) und
  -- XOR-Regeln einhalten.
  for r in
    select u.von_code,
           count(*) filter (where u.bedingung is null) as ohne,
           max(u.sequence) filter (where u.bedingung is null) as ohne_seq,
           max(u.sequence) as max_seq
    from prozess_uebergaenge u
    join prozess_schritte s on s.version_id = u.version_id and s.code = u.von_code
    where u.version_id = p_version and s.art = 'xor'
    group by u.von_code
  loop
    if r.ohne > 1 then
      raise exception 'XOR %: höchstens eine bedingungslose Default-Kante', r.von_code;
    end if;
    if r.ohne = 1 and r.ohne_seq < r.max_seq then
      raise exception 'XOR %: die Default-Kante muss die letzte sein', r.von_code;
    end if;
  end loop;

  -- Doppelt gemappte Zustände machen den Belegstandort mehrdeutig.
  for r in
    select zustand, count(*) as n from prozess_schritte
    where version_id = p_version and zustand is not null
    group by zustand having count(*) > 1
  loop
    raise exception 'Zustand „%" ist % Schritten zugeordnet — je Version nur einem', r.zustand, r.n;
  end loop;

  -- Erreichbarkeit über Fixpunkt-Iteration von ALLEN Starts aus.
  select array_agg(code) into erreicht from prozess_schritte
  where version_id = p_version and art = 'start';
  for rest in 1 .. gesamt loop
    select array_agg(distinct u.nach_code) into neu
    from prozess_uebergaenge u
    where u.version_id = p_version
      and u.von_code = any(erreicht)
      and not (u.nach_code = any(erreicht));
    exit when neu is null;
    erreicht := erreicht || neu;
  end loop;
  if array_length(erreicht, 1) < gesamt then
    raise exception 'Nicht alle Schritte sind von einem Start aus erreichbar (%/%)',
      array_length(erreicht, 1), gesamt;
  end if;

  -- Azyklik: Kahn-Abbau — bleiben Kanten übrig, gibt es eine Schleife.
  declare
    knoten text[];
    ohne_eingang text[];
  begin
    select array_agg(code) into knoten from prozess_schritte where version_id = p_version;
    for rest in 1 .. gesamt loop
      select array_agg(s.code) into ohne_eingang
      from prozess_schritte s
      where s.version_id = p_version and s.code = any(knoten)
        and not exists (
          select 1 from prozess_uebergaenge u
          where u.version_id = p_version and u.nach_code = s.code
            and u.von_code = any(knoten));
      exit when ohne_eingang is null;
      knoten := (select array_agg(k) from unnest(knoten) k where not (k = any(ohne_eingang)));
      exit when knoten is null;
    end loop;
    if knoten is not null and array_length(knoten, 1) > 0 then
      raise exception 'Der Prozess enthält eine Schleife (%: Schleifen sind nicht erlaubt)',
        array_to_string(knoten, ', ');
    end if;
  end;

  update prozess_versionen set status = 'archiviert'
  where prozess_id = v_prozess and status = 'aktiv';
  update prozess_versionen set status = 'aktiv', aktiviert_am = now()
  where id = p_version;
end $$;

-- prozess_version_kopieren um die neuen Spalten ergänzen.
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
                                rollen, params, optional)
  select v_neu, code, name, art, sequence, aktion, job_kind,
         ereignis, matching_tabelle, matching_bedingung,
         teilprozess, teilprozess_link, zustand,
         rollen, params, optional
  from prozess_schritte where version_id = v_alt;

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  select v_neu, von_code, nach_code, sequence, bedingung, beschriftung
  from prozess_uebergaenge where version_id = v_alt;

  return v_neu;
end $$;
