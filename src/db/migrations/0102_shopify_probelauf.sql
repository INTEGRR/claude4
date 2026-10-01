-- ============================================================================
-- 0102  Shopify-Probelauf: KRNL tut, als wäre es scharf, sendet aber nichts
-- ----------------------------------------------------------------------------
-- Dritter Modus neben „lesen" und „schreiben" (settings.shopify.modus =
-- 'probe'): alle Auslöser laufen wie im Schreibmodus, jede Mutation wird an
-- der einen Naht (shopifyGraphQL) NICHT gesendet, sondern als „würde senden"
-- protokolliert (api_transactions, kind 'probe:<operation>') und unten im
-- Bildschirm angezeigt. Damit lässt sich vor dem Scharfschalten im
-- laufenden Betrieb sehen, was KRNL an Shopify schicken würde.
--
-- Der Bestandsabgleich merkt sich im Probelauf getrennt, was er gemeldet
-- HÄTTE — so zeigt jede Runde nur Änderungen, und beim echten
-- Scharfschalten wird trotzdem alles einmal wirklich gemeldet (pushed_qty
-- und mto_eingerichtet_at bleiben unberührt).
-- Entscheidungslog 2026-10-01, „Shopify-Probelauf".
-- ============================================================================

alter table shopify_inventory_state
  add column if not exists probe_qty numeric(16,4),
  add column if not exists probe_at timestamptz,
  add column if not exists probe_eingerichtet_at timestamptz;

comment on column shopify_inventory_state.probe_qty is
  'Probelauf (0102): Menge, die KRNL gemeldet HÄTTE — getrennt von pushed_qty';
comment on column shopify_inventory_state.probe_eingerichtet_at is
  'Probelauf (0102): Made-to-Order-Einrichtung wäre gesendet worden — getrennt von mto_eingerichtet_at';
