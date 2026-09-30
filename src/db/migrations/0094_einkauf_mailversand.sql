-- ============================================================================
-- 0094  Einkauf, Stufe 2b — aus KRNL schreiben, Vorlagen, Übersetzung
-- ----------------------------------------------------------------------------
-- Mails an Lieferanten entstehen als Entwurf (`mail_entwuerfe`) — von Hand,
-- aus einer Vorlage in der Sprache des Lieferanten, aus der Bestellung (mit
-- PDF) und ab Stufe 6 vom Agenten. Ein Mensch gibt frei; gesendet wird als
-- Dienstschritt `gmail_senden` im bestehenden Thread (In-Reply-To/
-- References). Der Deutsch-Text bleibt neben der Zielsprache stehen —
-- jeder im Team liest mit. KI-Übersetzungen werden in `ki_verbrauch`
-- mitgeschrieben (Token je Zweck). Entscheidungslog 2026-09-30.
-- ============================================================================

create type mail_entwurf_status as enum ('entwurf', 'freigegeben', 'gesendet', 'verworfen');

-- Das Bestell-PDF bekommt eine eigene Art (nicht im selben Lauf benutzt).
alter type dokument_art add value if not exists 'bestellung';

create table mail_vorlagen (
  id          uuid primary key default gen_random_uuid(),
  anlass      text not null check (anlass in ('anfrage', 'pi_anfordern', 'liefertermin', 'muster_feedback', 'bestellung')),
  sprache     text not null check (sprache in ('de', 'en', 'zh')),
  betreff     text not null,
  text        text not null,
  aktiv       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  unique (anlass, sprache)
);
select attach_touch_trigger('mail_vorlagen');

comment on table mail_vorlagen is
  'Mail-Vorlagen des Einkaufs je Anlass und Sprache (0094) — Platzhalter {{ansprechpartner}}, {{bestellnummer}}, {{liefertermin}}, {{einkaeufer}}, {{firma}}, {{lieferant}}';

create table mail_entwuerfe (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid references mail_threads on delete set null,
  partner_id           uuid references partners on delete set null,
  purchase_order_id    uuid references purchase_orders on delete set null,
  an                   text[] not null default '{}',
  cc                   text[] not null default '{}',
  betreff              text not null default '',
  -- Deutsch zum Mitlesen; text_ziel in der Sprache des Lieferanten (bei 'de' leer).
  text_de              text not null default '',
  text_ziel            text,
  sprache              text not null default 'de' check (sprache in ('de', 'en', 'zh')),
  vorlage              text,
  anhang_dokument_ids  uuid[] not null default '{}',
  status               mail_entwurf_status not null default 'entwurf',
  quelle               text not null default 'mensch' check (quelle in ('mensch', 'agent')),
  antwort_erwartet_bis date,
  erstellt_von         text,
  zustaendig_id        uuid references users on delete set null,
  freigegeben_von      text,
  freigegeben_am       timestamptz,
  gesendet_am          timestamptz,
  gmail_message_id     text,
  nachricht_id         uuid references mail_nachrichten on delete set null,
  fehler               text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz
);
select attach_touch_trigger('mail_entwuerfe');
create index mail_entwuerfe_offen_idx on mail_entwuerfe (created_at desc) where status in ('entwurf', 'freigegeben');
create index mail_entwuerfe_thread_idx on mail_entwuerfe (thread_id);

comment on table mail_entwuerfe is
  'Ausgehende Mails des Einkaufs als Beleg (0094): Entwurf → Freigabe durch einen Menschen → gesendet (Dienst gmail_senden). Quelle mensch oder agent';

create table ki_verbrauch (
  id             uuid primary key default gen_random_uuid(),
  ebene          text not null,
  modell         text not null,
  zweck          text not null,
  modell_bezug   text,
  record_id      uuid,
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  created_at     timestamptz not null default now()
);
create index ki_verbrauch_zeit_idx on ki_verbrauch (created_at desc);

comment on table ki_verbrauch is
  'Token-Verbrauch der KI je Aufruf (0094) — Ebene, Modell, Zweck (z. B. uebersetzung_entwurf), Bezugsbeleg';

-- Prozessmodell und Prozess „Mail an Lieferanten".
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('mail_entwurf', 'mail_entwuerfe', 'status', '/einkauf/entwuerfe/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('mail_versand', 'Mail an Lieferanten',
          'Eine Mail an einen Lieferanten entwerfen (von Hand, aus Vorlage, aus der Bestellung oder vom Agenten), '
          || 'von einem Menschen freigeben lassen und im bestehenden Gespräch über das Einkaufspostfach senden.',
          'einkauf', 'mail_entwurf')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0094')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, job_kind, zustand)
  values
    (v_version, 'start',     'Anlass',                   'start',  0,  null,                          null,           null),
    (v_version, 'anlegen',   'Entwurf schreiben',        'aktion', 10, 'einkauf.mail_entwurf_anlegen', null,          'entwurf'),
    (v_version, 'freigeben', 'Freigeben und senden',     'aktion', 20, 'einkauf.mail_freigeben',       null,          'freigegeben'),
    (v_version, 'senden',    'Über das Postfach senden', 'dienst', 30, null,                           'gmail_senden', 'gesendet'),
    (v_version, 'verwerfen', 'Verwerfen',                'aktion', 40, 'einkauf.mail_verwerfen',       null,          'verworfen'),
    (v_version, 'ende',      'Erledigt',                 'ende',   90, null,                           null,          null);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',     'anlegen',   10, null),
    (v_version, 'anlegen',   'freigeben', 10, 'passt'),
    (v_version, 'anlegen',   'verwerfen', 20, 'doch nicht'),
    (v_version, 'freigeben', 'senden',    10, null),
    (v_version, 'senden',    'ende',      10, null),
    (v_version, 'verwerfen', 'ende',      10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/einkauf/entwuerfe', 'mail_versand', null)
on conflict (pfad_muster) do nothing;

-- Wer einkauft, schreibt Lieferanten.
update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'mail_versand')
 where 'einkauf_wareneingang_rechnung' = any(prozess_codes)
   and not ('mail_versand' = any(prozess_codes));

-- Vorlagen: fünf Anlässe × Deutsch, Englisch, Chinesisch.
insert into mail_vorlagen (anlass, sprache, betreff, text) values
('anfrage', 'de', 'Preisanfrage – {{firma}}',
$t$Guten Tag {{ansprechpartner}},

wir bitten um ein Angebot für die folgenden Teile (Zeichnungen/Stückliste anbei):

- Artikel:
- Menge(n):
- Gewünschter Liefertermin:

Bitte nennen Sie uns den Stückpreis je Staffel, MOQ, Lieferzeit, Incoterm und Zahlungsbedingungen sowie eventuelle Werkzeug- oder Musterkosten.

Vielen Dank und freundliche Grüße
{{einkaeufer}}
{{firma}}$t$),
('anfrage', 'en', 'Request for quotation – {{firma}}',
$t$Dear {{ansprechpartner}},

please send us your quotation for the following parts (drawings / BOM attached):

- Part:
- Quantity/quantities:
- Required delivery date:

Please state the unit price per quantity tier, MOQ, lead time, Incoterm and payment terms as well as any tooling or sample costs.

Thank you and best regards
{{einkaeufer}}
{{firma}}$t$),
('anfrage', 'zh', '询价 – {{firma}}',
$t${{ansprechpartner}}，您好！

请就以下零件报价（图纸/物料清单见附件）：

- 产品：
- 数量：
- 期望交期：

请提供各数量阶梯的单价、最小起订量（MOQ）、交期、贸易条款（Incoterm）和付款方式，以及模具费或样品费（如有）。

谢谢！
{{einkaeufer}}
{{firma}}$t$),

('pi_anfordern', 'de', 'Proforma-Rechnung zu Bestellung {{bestellnummer}}',
$t$Guten Tag {{ansprechpartner}},

bitte senden Sie uns zu unserer Bestellung {{bestellnummer}} die Proforma-Rechnung (PI) bzw. die Rechnung. Bitte geben Sie darauf unsere Bestellnummer, Ihre Bankverbindung und den Zahlungsplan (Anzahlung/Restzahlung) an.

Vielen Dank und freundliche Grüße
{{einkaeufer}}
{{firma}}$t$),
('pi_anfordern', 'en', 'Proforma invoice for purchase order {{bestellnummer}}',
$t$Dear {{ansprechpartner}},

please send us the proforma invoice (PI) or invoice for our purchase order {{bestellnummer}}. Please include our PO number, your bank details and the payment schedule (deposit/balance).

Thank you and best regards
{{einkaeufer}}
{{firma}}$t$),
('pi_anfordern', 'zh', '采购订单 {{bestellnummer}} 的形式发票',
$t${{ansprechpartner}}，您好！

请发送我们采购订单 {{bestellnummer}} 的形式发票（PI）或正式发票，并注明我们的订单号、贵司的银行信息以及付款安排（定金/尾款）。

谢谢！
{{einkaeufer}}
{{firma}}$t$),

('liefertermin', 'de', 'Liefertermin und Tracking zu Bestellung {{bestellnummer}}',
$t$Guten Tag {{ansprechpartner}},

bitte bestätigen Sie uns den Liefertermin für unsere Bestellung {{bestellnummer}} (bisher: {{liefertermin}}). Sobald die Ware versendet ist, senden Sie uns bitte die Sendungsnummer (Tracking), die Handelsrechnung (CI) und die Packliste.

Vielen Dank und freundliche Grüße
{{einkaeufer}}
{{firma}}$t$),
('liefertermin', 'en', 'Delivery date and tracking for purchase order {{bestellnummer}}',
$t$Dear {{ansprechpartner}},

please confirm the delivery date for our purchase order {{bestellnummer}} (current: {{liefertermin}}). Once the goods have shipped, please send us the tracking number, the commercial invoice (CI) and the packing list.

Thank you and best regards
{{einkaeufer}}
{{firma}}$t$),
('liefertermin', 'zh', '采购订单 {{bestellnummer}} 的交期和物流单号',
$t${{ansprechpartner}}，您好！

请确认我们采购订单 {{bestellnummer}} 的交货日期（目前为：{{liefertermin}}）。发货后请提供物流单号、商业发票（CI）和装箱单。

谢谢！
{{einkaeufer}}
{{firma}}$t$),

('muster_feedback', 'de', 'Feedback zu den Mustern',
$t$Guten Tag {{ansprechpartner}},

vielen Dank für die Muster. Unser Feedback:

- In Ordnung:
- Bitte ändern:
- Nächster Schritt:

Bitte bestätigen Sie die Änderungen und den neuen Termin.

Freundliche Grüße
{{einkaeufer}}
{{firma}}$t$),
('muster_feedback', 'en', 'Feedback on the samples',
$t$Dear {{ansprechpartner}},

thank you for the samples. Our feedback:

- OK:
- Please change:
- Next step:

Please confirm the changes and the new date.

Best regards
{{einkaeufer}}
{{firma}}$t$),
('muster_feedback', 'zh', '样品反馈',
$t${{ansprechpartner}}，您好！

感谢您寄来的样品。我们的反馈如下：

- 合格：
- 需要修改：
- 下一步：

请确认修改内容和新的日期。

谢谢！
{{einkaeufer}}
{{firma}}$t$),

('bestellung', 'de', 'Bestellung {{bestellnummer}} – {{firma}}',
$t$Guten Tag {{ansprechpartner}},

anbei erhalten Sie unsere Bestellung {{bestellnummer}}. Bitte bestätigen Sie Preise und Liefertermin und senden Sie uns Ihre Proforma-Rechnung.

Vielen Dank und freundliche Grüße
{{einkaeufer}}
{{firma}}$t$),
('bestellung', 'en', 'Purchase order {{bestellnummer}} – {{firma}}',
$t$Dear {{ansprechpartner}},

please find attached our purchase order {{bestellnummer}}. Please confirm prices and delivery date and send us your proforma invoice.

Thank you and best regards
{{einkaeufer}}
{{firma}}$t$),
('bestellung', 'zh', '采购订单 {{bestellnummer}} – {{firma}}',
$t${{ansprechpartner}}，您好！

附件是我们的采购订单 {{bestellnummer}}。请确认价格和交期，并发送形式发票给我们。

谢谢！
{{einkaeufer}}
{{firma}}$t$);

-- Betriebsdaten löschen: Vorlagen sind Konfiguration wie Arbeitsplätze.
-- Voller Körper aus 0087, Behalten-Liste um mail_vorlagen erweitert.
create or replace function demodaten_loeschen()
returns void language plpgsql
set search_path = public, pg_temp as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
    -- Zweiter Faktor (0083): gehört zum Konto, nicht zu den Betriebsdaten.
    'backup_codes', 'vertraute_geraete',
    'uom_categories', 'uoms', 'currencies', 'exchange_rates',
    'warehouses', 'stock_locations', 'operation_types',
    'taxes', 'payment_terms', 'incoterms', 'product_categories',
    'sequences', 'tags',
    'prozesse', 'prozess_versionen', 'prozess_schritte', 'prozess_uebergaenge',
    'prozess_modelle', 'prozess_routen', 'prozess_overrides',
    'feld_definitionen', 'prozess_pakete',
    'shipping_rules',
    'nutzungs_zaehler',
    -- Finanz-Konfiguration (0058): Konten bleiben, Bewegungen fallen.
    'bankkonten',
    -- Vertriebseingang der öffentlichen Startseite (0066): kein
    -- Betriebsdatum, keine zweite Quelle.
    'registrierungen',
    -- Arbeitsplätze mit Druckern (0087): die Einrichtung der Tische bleibt.
    'work_centers', 'drucker', 'arbeitsplatz_druckwege',
    -- Mail-Vorlagen des Einkaufs (0094): Texte je Sprache sind Einrichtung.
    'mail_vorlagen'
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
