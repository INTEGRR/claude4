-- ============================================================================
-- 0099  Bestandsbuchungen der Odoo-Übernahme nachträglich markieren
-- ----------------------------------------------------------------------------
-- Seit heute trägt jede Inventurzählung der Odoo-Übernahme die Notiz
-- „Odoo-Übernahme <Lauf>" (Entscheidungslog 2026-09-30, „Fertigprodukte
-- ohne Odoo-Bestand"). Die Läufe davor (API-Übernahme seit 0090) schrieben
-- keine Notiz. Ihre Zählungen erkennt man an: gebucht, Buchbestand 0,
-- Variante aus einer Odoo-Zuordnung (odoo_verweise), angelegt seit
-- 2026-09-29. Nur daran erkennt der Knopf „Fertigbestand zurücknehmen",
-- dass ein Bestand aus Odoo stammt — von Hand gezählter Bestand bleibt
-- damit immer unangetastet.
-- ============================================================================

update inventory_counts ic
set note = 'Odoo-Übernahme (vor 0099, nachgetragen)'
where ic.note is null
  and ic.applied_at is not null
  and ic.book_qty = 0
  and ic.created_at >= '2026-09-29'
  and exists (select 1 from odoo_verweise v
              where v.krnl_tabelle = 'product_variants' and v.krnl_id = ic.variant_id);
