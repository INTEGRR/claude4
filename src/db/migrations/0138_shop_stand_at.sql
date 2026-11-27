-- ===========================================================================
-- 0138  Stand der Shop-Bestellung merken — Echos nicht noch einmal holen
-- ===========================================================================
-- Shopify schickt zu jedem Kauf mehrere Ereignisse (create, updated, oft
-- mit demselben Stand). Jedes kostete bisher einen Abruf der Bestellung im
-- Shop — unter Last frisst das genau das Abruf-Kontingent, das die
-- Mengenmeldungen brauchen (Lasttest 2026-11-27). KRNL merkt sich deshalb,
-- welchen Stand (updated_at laut Shop) es zuletzt eingelesen hat; ein
-- Ereignis mit demselben oder älterem Stand wird ohne Abruf erledigt.

alter table sales_orders add column shopify_stand_at timestamptz;
comment on column sales_orders.shopify_stand_at is
  'updated_at der Shop-Bestellung beim letzten Einlesen — ältere/gleiche Ereignisse brauchen keinen Abruf (0138)';
