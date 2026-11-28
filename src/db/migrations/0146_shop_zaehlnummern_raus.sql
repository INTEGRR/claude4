-- 0146: Shop-Zählnummern aus den Artikelnummern nehmen (Betreiber 2026-11-28:
-- „SH-Nummern vollkommen egal, kommen alle raus — relevant sind nur die
-- Nummern wie SW-GT-LS-001").
--
-- Bis zum 28.11. überschrieb jedes Produkt-Update aus Shopify die
-- Artikelnummer der verknüpften Variante — auch mit Shopifys fortlaufender
-- Zählnummer („SH00000117") oder mit einem leeren Text. Der Code lässt das
-- seit heute nicht mehr zu; hier wird der Bestand bereinigt.
-- Nur das Feld Artikelnummer: Bestände, Zählungen, Belege und die
-- Shop-Verknüpfung (shopify_variant_id) bleiben unberührt.

-- DESTRUKTIV: entfernt Artikelnummern der Form SH<Ziffern> (Shopify-Zählnummern ohne Bedeutung in KRNL) und leere Texte; echte Artikelnummern bleiben.
update product_variants set sku = null
where sku = '' or sku ~* '^SH[0-9]+$';

-- Drei Nummern, deren alter Wert belegt ist (am 27.11. aus der Produktion
-- gelesen, bevor sie überschrieben waren): die Gateron-Switches Silver, Blue
-- und Brown. Gesetzt nur, wo das Feld jetzt leer und die Nummer frei ist.
update product_variants pv set sku = k.sku
from (values ('G PRO 2.0 Silver', 'SW-GT-LS-001'),
             ('G PRO 2.0 BLUE',   'SW-GT-CB-001'),
             ('G PRO 2.0 BROWN',  'SW-GT-TB-001')) as k(wert, sku)
where pv.sku is null and pv.active
  and pv.display_name ilike 'GATERON%Switches%' and pv.display_name ilike '%' || k.wert || '%'
  and not exists (select 1 from product_variants x where x.sku = k.sku);
