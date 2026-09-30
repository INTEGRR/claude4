-- ============================================================================
-- 0093  Einkauf, Stufe 2a — Einkaufspostfach lesen und zuordnen
-- ----------------------------------------------------------------------------
-- KRNL liest das Einkaufspostfach (Google Workspace, Gmail-API) und legt
-- jede Mail als Nachricht in einem Thread ab. Threads werden automatisch
-- zugeordnet — Absender-Domain → Lieferant (partners.mail_domains),
-- Bestellnummer im Betreff → Bestellung, Folgemails erben die Zuordnung des
-- Threads —, sonst stehen sie im Posteingang. Anhänge wandern in die
-- geteilte Ablage (dokumente, 0092). Alibaba-Chats und Telefonate werden von
-- Hand als Nachricht erfasst. Wiedervorlagen („Antwort erwartet bis",
-- „Liefertermin prüfen") hält `wiedervorlagen` — regelbasierte kommen mit
-- Stufe 5 als Sicht dazu. Entscheidungslog 2026-09-30.
-- ============================================================================

create type mail_richtung as enum ('eingang', 'ausgang');
create type mail_kanal as enum ('email', 'alibaba', 'telefon', 'sonstiges');
create type mail_thread_status as enum ('offen', 'erledigt', 'ignoriert');
create type zuordnung_quelle as enum ('regel', 'mensch', 'agent');

create table mail_threads (
  id                uuid primary key default gen_random_uuid(),
  gmail_thread_id   text unique,
  betreff           text,
  partner_id        uuid references partners on delete set null,
  purchase_order_id uuid references purchase_orders on delete set null,
  zustaendig_id     uuid references users on delete set null,
  status            mail_thread_status not null default 'offen',
  kanal             mail_kanal not null default 'email',
  letzte_richtung   mail_richtung,
  letzte_am         timestamptz,
  anzahl            int not null default 0,
  zugeordnet_durch  zuordnung_quelle,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('mail_threads');
create index mail_threads_partner_idx on mail_threads (partner_id, letzte_am desc);
create index mail_threads_po_idx on mail_threads (purchase_order_id);
create index mail_threads_offen_idx on mail_threads (letzte_am desc) where status = 'offen';

comment on table mail_threads is
  'Gesprächsfäden des Einkaufs (0093) — Gmail-Threads und von Hand erfasste Kanäle (Alibaba, Telefon), zugeordnet zu Lieferant und Bestellung';

create table mail_nachrichten (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid not null references mail_threads on delete cascade,
  gmail_message_id  text unique,
  rfc822_id         text,
  in_reply_to       text,
  richtung          mail_richtung not null,
  kanal             mail_kanal not null default 'email',
  von               text,
  von_name          text,
  an                text[] not null default '{}',
  cc                text[] not null default '{}',
  betreff           text,
  datum             timestamptz not null default now(),
  text              text,
  html              text,
  -- Deutsche Fassung (Übersetzung ab Stufe 2b) und erkannte Sprache.
  text_de           text,
  sprache           text,
  quelle            text not null default 'gmail' check (quelle in ('gmail', 'weitergeleitet', 'manuell')),
  erfasst_von       text,
  suche             tsvector generated always as
                      (to_tsvector('simple', coalesce(betreff, '') || ' ' || coalesce(text, ''))) stored,
  created_at        timestamptz not null default now()
);
create index mail_nachrichten_thread_idx on mail_nachrichten (thread_id, datum);
create index mail_nachrichten_suche_idx on mail_nachrichten using gin (suche);

create table mail_anhaenge (
  id                   uuid primary key default gen_random_uuid(),
  nachricht_id         uuid not null references mail_nachrichten on delete cascade,
  dateiname            text not null,
  mime                 text,
  groesse              bigint,
  gmail_attachment_id  text,
  dokument_id          uuid references dokumente on delete set null,
  fehler               text,
  created_at           timestamptz not null default now()
);
create index mail_anhaenge_nachricht_idx on mail_anhaenge (nachricht_id);

create table wiedervorlagen (
  id             uuid primary key default gen_random_uuid(),
  modell         text not null,
  record_id      uuid not null,
  faellig_am     date not null,
  grund          text not null,
  zustaendig_id  uuid references users on delete set null,
  erstellt_von   text,
  erledigt_am    timestamptz,
  erledigt_von   text,
  created_at     timestamptz not null default now()
);
create index wiedervorlagen_offen_idx on wiedervorlagen (faellig_am) where erledigt_am is null;
create index wiedervorlagen_beleg_idx on wiedervorlagen (modell, record_id);

comment on table wiedervorlagen is
  'Manuelle Wiedervorlagen des Einkaufs (0093): „Antwort erwartet bis", „Liefertermin prüfen" … — regelbasierte (fehlende PI, ETA überfällig) berechnet ab Stufe 5 eine Sicht';

-- Automatische Zuordnung eines Threads (Regel, nie über eine menschliche
-- Zuordnung hinweg): Bestellnummer im Betreff → Bestellung + deren
-- Lieferant; sonst der Gesprächspartner → Lieferant über
-- partners.mail_domains. Gesprächspartner ist der Absender der ersten
-- eingehenden Nachricht, bei einem von uns begonnenen Thread der erste
-- Empfänger. mail_domains hält Domains („pcbway.com", passt auch auf
-- Subdomains) und — für Freemailer wie qq.com/163.com, deren Domain nichts
-- über den Lieferanten sagt — volle Adressen; die volle Adresse gewinnt.
-- Liefert true, wenn etwas zugeordnet wurde.
create or replace function mail_thread_zuordnen(p_thread uuid)
returns boolean language plpgsql as $$
declare
  t mail_threads%rowtype;
  v_po uuid;
  v_vendor uuid;
  v_partner uuid;
  v_adresse text;
  v_domain text;
begin
  select * into t from mail_threads where id = p_thread for update;
  if t.id is null or t.zugeordnet_durch in ('mensch', 'agent') then return false; end if;

  if t.purchase_order_id is null then
    select po.id, po.vendor_id into v_po, v_vendor
    from purchase_orders po
    where po.number = substring(coalesce(t.betreff, '') from '(P[0-9]{5,})')
    limit 1;
  end if;

  if t.partner_id is null and v_vendor is null then
    select lower(n.von) into v_adresse
    from mail_nachrichten n
    where n.thread_id = p_thread and n.richtung = 'eingang' and n.von like '%@%'
    order by n.datum limit 1;
    if v_adresse is null then
      select lower(n.an[1]) into v_adresse
      from mail_nachrichten n
      where n.thread_id = p_thread and n.richtung = 'ausgang' and n.an[1] like '%@%'
      order by n.datum limit 1;
    end if;
    v_domain := split_part(v_adresse, '@', 2);
    if v_adresse is not null then
      select p.id into v_partner from partners p
      where v_adresse = any(p.mail_domains)
         or v_domain = any(p.mail_domains)
         or exists (select 1 from unnest(p.mail_domains) d
                    where position('@' in d) = 0 and v_domain like '%.' || d)
      order by (v_adresse = any(p.mail_domains)) desc, (v_domain = any(p.mail_domains)) desc
      limit 1;
    end if;
  end if;

  if v_po is null and v_vendor is null and v_partner is null then return false; end if;

  update mail_threads set
    purchase_order_id = coalesce(purchase_order_id, v_po),
    partner_id = coalesce(partner_id, v_vendor, v_partner),
    zustaendig_id = coalesce(zustaendig_id,
      (select p.einkaeufer_id from partners p where p.id = coalesce(t.partner_id, v_vendor, v_partner))),
    zugeordnet_durch = 'regel'
  where id = p_thread;
  return true;
end $$;

-- Prozessmodell für Kommentare/Dokumente am Thread (kein Prozess).
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('mail_thread', 'mail_threads', 'status', '/einkauf/posteingang/:id');
