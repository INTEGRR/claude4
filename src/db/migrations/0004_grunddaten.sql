-- ===========================================================================
-- Grunddaten: Maßeinheiten, die jedes System braucht
-- ===========================================================================

insert into uom_categories (name) values ('Einheit'), ('Gewicht'), ('Länge');

insert into uoms (category_id, name, ratio, is_reference, rounding)
select id, 'Stück', 1, true, 1 from uom_categories where name = 'Einheit';
insert into uoms (category_id, name, ratio, rounding)
select id, 'Dutzend', 12, 0.01 from uom_categories where name = 'Einheit';
insert into uoms (category_id, name, ratio, rounding)
select id, 'Hundert', 100, 0.01 from uom_categories where name = 'Einheit';

insert into uoms (category_id, name, ratio, is_reference, rounding)
select id, 'g', 1, true, 0.001 from uom_categories where name = 'Gewicht';
insert into uoms (category_id, name, ratio, rounding)
select id, 'kg', 1000, 0.001 from uom_categories where name = 'Gewicht';

insert into uoms (category_id, name, ratio, is_reference, rounding)
select id, 'mm', 1, true, 0.01 from uom_categories where name = 'Länge';
insert into uoms (category_id, name, ratio, rounding)
select id, 'm', 1000, 0.001 from uom_categories where name = 'Länge';
