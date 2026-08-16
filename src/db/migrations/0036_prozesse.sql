-- ===========================================================================
-- Prozessmodell: Prozesse als Daten (Prozess-lite)
-- ===========================================================================
--
-- Das ERP orientiert sich an Prozessen statt an Masken. Ein Prozess ist eine
-- versionierte Folge von Schritten mit Entscheidungen (XOR), Rollen und
-- Verknüpfungen zu den Bausteinen, die es längst gibt:
--
--   aktion   → Registry-Aktion (src/modules/prozesse/registry)
--   dienst   → Outbox-Job (integration_jobs, asynchron)
--   ereignis → eingehendes Ereignis (Webhook, Tracking) — der Prozess wartet
--   matching → Klärliste (z. B. shopify_unmatched_lines): offene Zeilen
--              blockieren, eine Aktion löst sie auf
--   xor      → Entscheidung über jsonb-Bedingungen (kein eval, s. u.)
--
-- Entwurfskern: **kein eigenes Token-Modell** für beleggebundene Prozesse.
-- Die Statusmaschinen der Belege (sales_orders.state, stock_pickings.state …)
-- bleiben die einzige Wahrheit; ein Schritt MAPPT über `zustand` auf den
-- Belegstatus nach seinem Erfolg. „Wo steht der Beleg?" ist damit eine
-- Abfrage, nie ein zweiter Zustand, der auseinanderlaufen könnte. Nur
-- beleglose Assistenten (Artikel anlegen) führen eine eigene Instanz.
--
-- Laufzeit-Änderbarkeit ohne Anfassen der (checksummierten, unveränderlichen)
-- Migrations-Seeds: Änderungen sind neue Versionszeilen
-- (prozess_version_kopieren → editieren → prozess_version_aktivieren) oder
-- firmenspezifische Overrides je Schritt-Code.

-- --- Modell-Whitelist -------------------------------------------------------
-- Brücke zu den Statusmaschinen: nur hier eingetragene Tabellen darf
-- prozess_beleg_daten() lesen — Tabellennamen kommen nie aus Nutzereingaben.

create table prozess_modelle (
  modell        text primary key,          -- 'sales_order', 'bug_report', …
  tabelle       text not null,
  status_spalte text not null default 'state',
  routen_muster text                       -- '/reparatur/:id' — Belegseite + Bug-Loop-Zuordnung
);

comment on table prozess_modelle is
  'Whitelist der prozessfähigen Belegmodelle: Tabelle + Statusspalte + Routenmuster.';

/*
 * Belegzeile als jsonb — die Datengrundlage für Gateway-Bedingungen.
 * format(%I) mit Werten aus der Whitelist: dynamisch, aber nie Nutzertext.
 */
create or replace function prozess_beleg_daten(p_modell text, p_id uuid)
returns jsonb
language plpgsql stable as $$
declare
  m prozess_modelle%rowtype;
  v_daten jsonb;
begin
  select * into m from prozess_modelle where modell = p_modell;
  if not found then
    raise exception 'Unbekanntes Prozessmodell: %', p_modell;
  end if;
  execute format('select to_jsonb(t) from %I t where id = $1', m.tabelle)
    into v_daten using p_id;
  if v_daten is null then
    raise exception 'Datensatz % in % nicht gefunden', p_id, m.tabelle;
  end if;
  return v_daten;
end $$;

-- --- Bedingungssprache ------------------------------------------------------
-- Rekursives jsonb-Prädikat über die Felder der Belegzeile:
--   {"alle": [b, …]} | {"eine": [b, …]} | {"nicht": b}
--   {"feld": "delivery_status", "op": "=", "wert": "full"}
-- Ops: = != in > >= < <= leer nicht_leer beginnt_mit
-- Numerisch verglichen wird, wenn beide Seiten numerisch lesbar sind.

create or replace function bedingung_pruefen(p_daten jsonb, p_bedingung jsonb)
returns boolean
language plpgsql immutable as $$
declare
  teil jsonb;
  v_feld text;
  v_op text;
  v_wert jsonb;
  ist jsonb;
  ist_text text;
  soll_text text;
begin
  if p_bedingung is null or p_bedingung = 'null'::jsonb then return true; end if;

  if p_bedingung ? 'alle' then
    for teil in select * from jsonb_array_elements(p_bedingung -> 'alle') loop
      if not bedingung_pruefen(p_daten, teil) then return false; end if;
    end loop;
    return true;
  end if;

  if p_bedingung ? 'eine' then
    for teil in select * from jsonb_array_elements(p_bedingung -> 'eine') loop
      if bedingung_pruefen(p_daten, teil) then return true; end if;
    end loop;
    return false;
  end if;

  if p_bedingung ? 'nicht' then
    return not bedingung_pruefen(p_daten, p_bedingung -> 'nicht');
  end if;

  v_feld := p_bedingung ->> 'feld';
  v_op   := p_bedingung ->> 'op';
  if v_feld is null or v_op is null then
    raise exception 'Ungültige Bedingung: %', p_bedingung;
  end if;

  ist := p_daten -> v_feld;
  ist_text := p_daten ->> v_feld;
  v_wert := p_bedingung -> 'wert';
  soll_text := p_bedingung ->> 'wert';

  if v_op = 'leer' then
    return ist is null or ist = 'null'::jsonb or ist_text = '';
  elsif v_op = 'nicht_leer' then
    return not (ist is null or ist = 'null'::jsonb or ist_text = '');
  elsif v_op = 'beginnt_mit' then
    return ist_text is not null and ist_text like soll_text || '%';
  elsif v_op = 'in' then
    return v_wert is not null
      and jsonb_typeof(v_wert) = 'array'
      and exists (select 1 from jsonb_array_elements_text(v_wert) w where w = ist_text);
  elsif v_op in ('=', '!=') then
    if (v_op = '=') = (ist_text is not distinct from soll_text) then return true; end if;
    -- „1" und „1.0" sollen gleich sein: numerischer Zweitversuch.
    if ist_text ~ '^-?[0-9]+(\.[0-9]+)?$' and soll_text ~ '^-?[0-9]+(\.[0-9]+)?$' then
      return (v_op = '=') = (ist_text::numeric = soll_text::numeric);
    end if;
    return false;
  elsif v_op in ('>', '>=', '<', '<=') then
    if ist_text is null or soll_text is null
       or ist_text !~ '^-?[0-9]+(\.[0-9]+)?$' or soll_text !~ '^-?[0-9]+(\.[0-9]+)?$' then
      return false;
    end if;
    return case v_op
      when '>'  then ist_text::numeric >  soll_text::numeric
      when '>=' then ist_text::numeric >= soll_text::numeric
      when '<'  then ist_text::numeric <  soll_text::numeric
      else           ist_text::numeric <= soll_text::numeric
    end;
  end if;

  raise exception 'Unbekannter Operator: %', v_op;
end $$;

comment on function bedingung_pruefen is
  'Wertet ein jsonb-Prädikat gegen eine Belegzeile aus — die Gateway-Sprache der Prozesse.';

-- --- Prozesse, Versionen, Schritte, Übergänge -------------------------------

create table prozesse (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,       -- stabiler Anker: 'reparatur', 'artikel_anlegen'
  name         text not null,
  beschreibung text,
  bereich      text not null,              -- Area aus permissions.ts (TS-Test prüft Gültigkeit)
  modell       text references prozess_modelle,  -- null = beleglos (Instanz führt den Zustand)
  aktiv        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
select attach_touch_trigger('prozesse');

create table prozess_versionen (
  id           uuid primary key default gen_random_uuid(),
  prozess_id   uuid not null references prozesse on delete cascade,
  version      int not null,
  status       text not null default 'entwurf' check (status in ('entwurf', 'aktiv', 'archiviert')),
  hinweis      text,
  created_by   text not null default 'system',
  created_at   timestamptz not null default now(),
  aktiviert_am timestamptz,
  unique (prozess_id, version)
);
-- Genau eine aktive Version je Prozess.
create unique index prozess_versionen_aktiv_idx
  on prozess_versionen (prozess_id) where status = 'aktiv';

create type prozess_schritt_art as enum
  ('start', 'aktion', 'dienst', 'ereignis', 'matching', 'xor', 'ende');

create table prozess_schritte (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references prozess_versionen on delete cascade,
  code        text not null,               -- stabil über Versionen (Overrides/Fixtures/Tickets)
  name        text not null,
  art         prozess_schritt_art not null,
  sequence    int not null default 10,
  -- Verknüpfung je Art (geprüft im check unten):
  aktion             text,                 -- Registry-Name (art = aktion; auch matching: Auflöse-Aktion)
  job_kind           text,                 -- Job-Katalog (art = dienst)
  ereignis           text,                 -- Ereignis-Topic (art = ereignis)
  matching_tabelle   text,                 -- art = matching
  matching_bedingung jsonb,                -- Prädikat „Zeile ist offen"; Standard: resolved_at leer
  -- Statusmaschinen-Mapping: Belegstatus NACH erfolgreichem Schritt.
  zustand     text,
  rollen      text[],                      -- leer/null = jede Rolle mit Schreibrecht im Bereich
  params      jsonb not null default '{}',
  optional    boolean not null default false,
  unique (version_id, code),
  check (
    case art
      when 'aktion'   then aktion is not null
      when 'dienst'   then job_kind is not null
      when 'ereignis' then ereignis is not null
      when 'matching' then matching_tabelle is not null and aktion is not null
      else true
    end
  )
);
create index prozess_schritte_version_idx on prozess_schritte (version_id, sequence);

create table prozess_uebergaenge (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references prozess_versionen on delete cascade,
  von_code     text not null,
  nach_code    text not null,
  sequence     int not null default 10,    -- XOR: Auswertungsreihenfolge; Default-Kante zuletzt
  bedingung    jsonb,                      -- null = immer
  beschriftung text,                       -- Kantentext im Diagramm
  foreign key (version_id, von_code)  references prozess_schritte (version_id, code)
    on delete cascade deferrable initially deferred,
  foreign key (version_id, nach_code) references prozess_schritte (version_id, code)
    on delete cascade deferrable initially deferred
);
create index prozess_uebergaenge_von_idx on prozess_uebergaenge (version_id, von_code, sequence);

-- --- Instanzen (nur beleglose Prozesse) und Overrides -----------------------

insert into sequences (code, prefix, padding) values ('proz', 'PRZ/', 5);

create table prozess_instanzen (
  id            uuid primary key default gen_random_uuid(),
  number        text unique not null,
  prozess_id    uuid not null references prozesse,
  version_id    uuid not null references prozess_versionen,
  schritt_code  text not null,
  status        text not null default 'laufend'
    check (status in ('laufend', 'fertig', 'abgebrochen')),
  daten         jsonb not null default '{}',  -- Schrittergebnisse (IDs entstandener Belege …)
  gestartet_von text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  beendet_am    timestamptz
);
select attach_touch_trigger('prozess_instanzen');
create index prozess_instanzen_offen_idx on prozess_instanzen (prozess_id) where status = 'laufend';

create table prozess_overrides (
  id            uuid primary key default gen_random_uuid(),
  prozess_code  text not null,
  schritt_code  text not null,
  aktiv         boolean,                   -- false = Schritt abgeschaltet (nur optionale Schritte)
  rollen        text[],
  params        jsonb,                     -- wird über Definition-params gemergt (||)
  geaendert_von text,
  updated_at    timestamptz,
  unique (prozess_code, schritt_code)
);
select attach_touch_trigger('prozess_overrides');

comment on table prozess_overrides is
  'Firmenspezifische Laufzeit-Anpassung je Schritt-Code — überlebt Versionswechsel, '
  'weil sie an Codes bindet, nie an Versionszeilen.';

-- --- Routen-Zuordnung (Bug-Loop: Seite → Prozess) ---------------------------

create table prozess_routen (
  pfad_muster  text primary key,           -- '/lager/inventur', '/versand'
  prozess_code text not null,
  schritt_code text
);

comment on table prozess_routen is
  'Seiten ohne Belegmuster → Prozess: löst beim Fehler-Melden die Zuordnung auf.';

-- --- Bug-Loop: Tickets kennen ihren Prozess und ihren Testlauf --------------

alter table bug_reports
  add column prozess_code     text,
  add column schritt_code     text,
  add column aktion           text,        -- betroffene Registry-Aktion (optional)
  add column test_ok          boolean,     -- Ergebnis des letzten Prozesstestlaufs
  add column test_befund      text,
  add column test_commit_sha  text,
  add column test_gelaufen_am timestamptz;

-- --- Abfragen ---------------------------------------------------------------

create or replace function prozess_aktive_version(p_code text) returns uuid
language sql stable as $$
  select v.id from prozess_versionen v
  join prozesse p on p.id = v.prozess_id
  where p.code = p_code and v.status = 'aktiv'
$$;

/*
 * Wo steht ein Beleg in seinem Prozess?
 *
 * Beleggebunden: der Schritt, dessen `zustand` dem aktuellen Belegstatus
 * entspricht — die Aktivierung erzwingt, dass je Version kein Zustand doppelt
 * gemappt ist, deshalb ist das ein einfacher Nachschlag. Beleglos: aus der
 * Instanz.
 */
create or replace function prozess_aktueller_schritt(p_code text, p_record uuid)
returns text
language plpgsql stable as $$
declare
  v_version uuid := prozess_aktive_version(p_code);
  v_modell text;
  v_status text;
  v_schritt text;
begin
  if v_version is null then return null; end if;

  select p.modell into v_modell from prozesse p where p.code = p_code;

  if v_modell is null then
    select i.schritt_code into v_schritt from prozess_instanzen i where i.id = p_record;
    return v_schritt;
  end if;

  select prozess_beleg_daten(v_modell, p_record) ->>
         (select m.status_spalte from prozess_modelle m where m.modell = v_modell)
    into v_status;

  select s.code into v_schritt
  from prozess_schritte s
  where s.version_id = v_version and s.zustand = v_status
  limit 1;
  return v_schritt;
end $$;

/*
 * Welche Schritte sind JETZT möglich? Folgt den ausgehenden Übergängen des
 * aktuellen Schritts; XOR-Knoten sind Durchgangsstationen (ihre Kanten werden
 * in sequence-Reihenfolge ausgewertet, die erste erfüllte gewinnt, eine
 * bedingungslose Kante ist der Default). Overrides werden angewandt:
 * abgeschaltete optionale Schritte werden übersprungen (ihre Nachfolger
 * rücken nach), Rollen und Params aus dem Override gewinnen.
 */
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
  -- Ohne Standort (neuer Beleg / Prozessstart): ab dem Startknoten.
  if v_aktuell is null then
    select s.code into v_aktuell from prozess_schritte s
    where s.version_id = v_version and s.art = 'start' limit 1;
    if v_aktuell is null then return; end if;
  end if;

  warteschlange := array[v_aktuell];

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
      rollen   := coalesce(ov.rollen, ziel.rollen);
      params   := ziel.params || coalesce(ov.params, '{}'::jsonb);
      optional := ziel.optional;
      return next;
    end loop;
  end loop;
end $$;

-- --- Versionspflege ---------------------------------------------------------

/* Aktive Version samt Schritten und Übergängen als neuen Entwurf duplizieren. */
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
                                ereignis, matching_tabelle, matching_bedingung, zustand,
                                rollen, params, optional)
  select v_neu, code, name, art, sequence, aktion, job_kind,
         ereignis, matching_tabelle, matching_bedingung, zustand,
         rollen, params, optional
  from prozess_schritte where version_id = v_alt;

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  select v_neu, von_code, nach_code, sequence, bedingung, beschriftung
  from prozess_uebergaenge where version_id = v_alt;

  return v_neu;
end $$;

/*
 * Entwurf prüfen und aktiv schalten. Die Validierung ist der Riegel, der
 * kaputte Prozesse von der Laufzeit fernhält:
 *   - genau ein Start, mindestens ein Ende
 *   - jeder Schritt vom Start aus erreichbar
 *   - azyklisch (Schleifen sind in v1 bewusst verboten)
 *   - XOR: höchstens eine bedingungslose Kante, und nur als letzte
 *   - je Version kein Belegzustand doppelt gemappt (macht den Standort eindeutig)
 */
create or replace function prozess_version_aktivieren(p_version uuid)
returns void
language plpgsql as $$
declare
  v_prozess uuid;
  v_start int;
  v_ende int;
  gesamt int;
  erreicht text[];
  rest int;
  neu text[];
  r record;
begin
  select prozess_id into v_prozess from prozess_versionen where id = p_version;
  if v_prozess is null then raise exception 'Unbekannte Version'; end if;

  select count(*) filter (where art = 'start'),
         count(*) filter (where art = 'ende'),
         count(*)
    into v_start, v_ende, gesamt
  from prozess_schritte where version_id = p_version;

  if v_start <> 1 then raise exception 'Ein Prozess braucht genau einen Startschritt (hat %)', v_start; end if;
  if v_ende < 1 then raise exception 'Ein Prozess braucht mindestens einen Endschritt'; end if;

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

  -- Erreichbarkeit + Azyklik über Fixpunkt-Iteration vom Start aus; ein
  -- Zyklus fiele als nie fertig werdende Restmenge auf, wird aber schon
  -- vorher über die Kantenzahl-Schranke abgefangen.
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
    raise exception 'Nicht alle Schritte sind vom Start aus erreichbar (%/%)',
      array_length(erreicht, 1), gesamt;
  end if;

  -- Azyklik: Kahn-Abbau — bleiben Kanten übrig, gibt es eine Schleife.
  declare
    knoten text[];
    kanten int;
    ohne_eingang text[];
  begin
    select array_agg(code) into knoten from prozess_schritte where version_id = p_version;
    select count(*) into kanten from prozess_uebergaenge where version_id = p_version;
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

-- --- Instanzen (beleglose Prozesse) -----------------------------------------

create or replace function prozess_instanz_starten(p_code text, p_actor text)
returns uuid
language plpgsql as $$
declare
  v_prozess prozesse%rowtype;
  v_version uuid;
  v_start text;
  v_id uuid;
begin
  select * into v_prozess from prozesse where code = p_code and aktiv;
  if not found then raise exception 'Unbekannter oder inaktiver Prozess: %', p_code; end if;
  if v_prozess.modell is not null then
    raise exception 'Prozess % ist beleggebunden — der Beleg führt den Zustand', p_code;
  end if;
  v_version := prozess_aktive_version(p_code);
  if v_version is null then raise exception 'Prozess % hat keine aktive Version', p_code; end if;

  select code into v_start from prozess_schritte
  where version_id = v_version and art = 'start';

  insert into prozess_instanzen (number, prozess_id, version_id, schritt_code, gestartet_von)
  values (next_sequence('proz'), v_prozess.id, v_version, v_start, p_actor)
  returning id into v_id;

  perform log_event('prozess_instanz', v_id, 'state', 'Gestartet: ' || v_prozess.name, p_actor);
  return v_id;
end $$;

/* Instanz einen Schritt weiterschalten und dessen Ergebnis festhalten. */
create or replace function prozess_instanz_weiter(
  p_instanz uuid, p_schritt text, p_ergebnis jsonb default '{}'::jsonb, p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  i prozess_instanzen%rowtype;
  v_ende boolean;
begin
  select * into i from prozess_instanzen where id = p_instanz for update;
  if not found then raise exception 'Instanz nicht gefunden'; end if;
  if i.status <> 'laufend' then raise exception 'Instanz ist bereits %', i.status; end if;

  if not exists (
    select 1 from prozess_schritte s
    where s.version_id = i.version_id and s.code = p_schritt
  ) then
    raise exception 'Schritt % gehört nicht zu diesem Prozess', p_schritt;
  end if;

  -- Führt vom neuen Schritt keine Kante mehr weg (oder nur zu Enden), ist die
  -- Instanz fertig.
  select not exists (
    select 1 from prozess_uebergaenge u
    join prozess_schritte z on z.version_id = u.version_id and z.code = u.nach_code
    where u.version_id = i.version_id and u.von_code = p_schritt and z.art <> 'ende'
  ) into v_ende;

  update prozess_instanzen set
    schritt_code = p_schritt,
    daten = daten || coalesce(p_ergebnis, '{}'::jsonb),
    status = case when v_ende then 'fertig' else status end,
    beendet_am = case when v_ende then now() else beendet_am end
  where id = p_instanz;

  perform log_event('prozess_instanz', p_instanz, 'state',
    'Schritt: ' || p_schritt || case when v_ende then ' (fertig)' else '' end, p_actor);
end $$;

-- --- Neustart-Knopf: Prozessdefinitionen sind Konfiguration -----------------
-- Definitionen (Prozesse, Versionen, Schritte, Übergänge, Modelle, Routen,
-- Overrides) überleben den Wipe; Instanzen sind Bewegungsdaten und fallen.

create or replace function demodaten_loeschen() returns void
language plpgsql as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
    'uom_categories', 'uoms', 'currencies', 'exchange_rates',
    'warehouses', 'stock_locations', 'operation_types',
    'taxes', 'payment_terms', 'incoterms', 'product_categories',
    'sequences', 'tags',
    'prozesse', 'prozess_versionen', 'prozess_schritte', 'prozess_uebergaenge',
    'prozess_modelle', 'prozess_routen', 'prozess_overrides',
    -- Versandregeln sind Konfiguration ohne Fremdschlüssel und bleiben.
    -- Kartonagen NICHT: sie verweisen auf Produktvarianten — blieben sie
    -- stehen, ließe sich product_variants nicht mehr leeren.
    'shipping_rules'
  ];
  v_liste text;
  r record;
begin
  select string_agg(format('%I', tablename), ', ' order by tablename)
    into v_liste
  from pg_tables
  where schemaname = current_schema()
    and tablename <> all (v_behalten);

  if v_liste is not null then
    execute 'truncate table ' || v_liste;
  end if;

  delete from sessions where user_id in (
    select id from users
    where lower(email) in ('lager@example.com', 'fertigung@example.com'));
  delete from users
  where lower(email) in ('lager@example.com', 'fertigung@example.com');

  update sequences set next_number = 1;
  for r in select code from sequences loop
    execute format('alter sequence %I restart with 1', 'seq_' || r.code);
  end loop;

  insert into settings (key, value)
  values ('demo', jsonb_build_object('geloescht', true, 'zeitpunkt', now()))
  on conflict (key) do update set value = excluded.value;

  perform refresh_analytics('demodaten-loeschen');
end $$;
