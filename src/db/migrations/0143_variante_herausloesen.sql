-- ===========================================================================
-- 0143  Variante als eigenes Produkt herauslösen
-- ===========================================================================
-- KRNL übernimmt Shop-Produkte eins zu eins: was in Shopify Variante eines
-- Produkts ist, ist es auch hier. Das passt nicht immer — der Cherry „Silent
-- Red" steht im Shop als Variante des Produkts „GATERON Switches", ist für
-- Lager, Stücklisten und Einkauf aber ein eigener Artikel. „Herauslösen"
-- (produkte.variante_herausloesen, Entscheidungslog 2026-11-27) zieht die
-- Variante in ein eigenes KRNL-Produkt um; ihre ID bleibt, damit Bestand,
-- Bewegungen, Stücklisten und Belege unverändert an ihr hängen. Die
-- Verknüpfung zur Shop-Variante bleibt ebenfalls.
--
--   shop_herausgeloest   Die Variante gehört im Shop zu einem Produkt, das
--                        in KRNL ein ANDERES Produkt ist. Folge: Titel,
--                        Beschreibung und Preise ihres KRNL-Produkts gehen
--                        nie an den Shop, und der Shop-Titel benennt ihr
--                        KRNL-Produkt nie um.

alter table product_variants
  add column shop_herausgeloest boolean not null default false;

comment on column product_variants.shop_herausgeloest is
  'Herausgelöst: im Shop Variante eines Produkts, das in KRNL ein anderes Produkt ist — Titel/Preise werden in keiner Richtung abgeglichen — 0143';
