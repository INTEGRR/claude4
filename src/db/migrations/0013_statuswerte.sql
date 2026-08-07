-- ===========================================================================
-- Odoo-Vervollständigung II: fehlende Statuswerte
-- ===========================================================================
-- Nur die Enum-Erweiterungen (neue Werte dürfen nicht in derselben
-- Transaktion verwendet werden, in der sie entstehen — Verwendung ab 0014).

-- sale_stock.delivery_status: pending | started | partial | full
alter type delivery_status add value if not exists 'started' before 'partial';

-- sale.order.invoice_status: no | to_invoice | invoiced | upselling
alter type invoice_status add value if not exists 'upselling';

-- stock.picking.type.reservation_method: at_confirm | manual | by_date
alter type reservation_method add value if not exists 'by_date';
