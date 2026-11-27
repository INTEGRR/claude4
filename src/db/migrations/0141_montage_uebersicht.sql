-- ===========================================================================
-- 0141  Montage-Übersicht: Gruppierung als Einstellung
-- ===========================================================================
-- Fertigung → Montage-Übersicht zeigt live, was noch zu bauen ist — gruppiert,
-- damit die Montage Gleiches am Stück vorbereitet („10 × HE · FR4 · Jade
-- Max": Switches in die Plate). Die Ebenen sind Daten, kein Code
-- (Entscheidungslog 2026-11-27): erst Stichwörter im Produktnamen, dann
-- Attribute in dieser Reihenfolge. Änderbar auf der Seite
-- (fertigung.montage_ebenen_setzen).
--
--   settings.montage = { "name_teile": ["HE","MX"], "attribute": ["Mounting Plate","Switches"] }

insert into settings (key, value)
values ('montage', '{"name_teile": ["HE", "MX"], "attribute": ["Mounting Plate", "Switches"]}'::jsonb)
on conflict (key) do nothing;
