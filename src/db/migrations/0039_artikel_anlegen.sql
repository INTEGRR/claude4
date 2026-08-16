-- ===========================================================================
-- P1: Artikel anlegen — der erste BELEGLOSE Prozess (Assistent)
-- ===========================================================================
--
-- Kein Beleg führt den Zustand: eine prozess_instanz trägt Schritt und
-- gesammelte Ergebnisse (daten jsonb). Die Maske ist vollständig GENERIERT —
-- /p/artikel_anlegen rendert die Schritte aus der Definition, die Formulare
-- aus den Registry-Schemas.
--
-- Bewusst schlank gesät (nur registrierte Aktionen, siehe 0037-Kopf):
-- der XOR-Beschaffungsweg (Einkaufsdaten | Stückliste) folgt, sobald die
-- Einkaufs-/Fertigungs-Aktionen in der Registry sind; der Shopify-Push als
-- Dienstschritt kommt mit der Dienst-Ausführung für Instanzen (Phase 5).

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('artikel_anlegen', 'Artikel anlegen',
          'Produkt mit Variantenmatrix anlegen, optional gleich den Meldebestand einrichten.',
          'produkte', null)
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, optional)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.optional
  from v, (values
    ('start',        'Neuer Artikel',                 'start',  0,  null,                          false),
    ('produkt',      'Produkt mit Varianten anlegen', 'aktion', 10, 'produkte.produkt_anlegen',    false),
    ('meldebestand', 'Meldebestand einrichten',       'aktion', 20, 'lager.meldebestand_anlegen',  true),
    ('ende',         'Fertig',                        'ende',   90, null,                          false)
  ) as t(code, name, art, seq, aktion, optional)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',        'produkt',      10, null),
  ('produkt',      'meldebestand', 10, 'Nachschub automatisch'),
  ('produkt',      'ende',         20, 'ohne Meldebestand'),
  ('meldebestand', 'ende',         10, null)
) as t(von, nach, seq, text);

-- Ticket-Zuordnung: Meldungen von der Assistentenseite gehören zu diesem Prozess.
insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/p/artikel_anlegen', 'artikel_anlegen', null);
