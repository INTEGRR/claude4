-- Nummernkreise hinter importierten Belegen nach vorn ziehen (Reparatur).
--
-- next_sequence() zieht seit 0026 aus der PG-Sequenz seq_<code>; die Tabelle
-- sequences ist nur noch der Startwert. Der Odoo-Import stellte aber genau
-- diese Tabelle (`update sequences set next_number = …`) — der 0026-Trigger
-- synchronisiert nur bei INSERT, nicht bei UPDATE. Auf einer importierten
-- Instanz stünde die nächste Belegnummer damit mitten im Altbestand: der
-- erste neue Auftrag zöge S00001 und kollidierte mit der Unique-Constraint
-- (auf der Prod-Instanz am 2026-08-27 verifiziert: seq_sale bei 1, Belege
-- bis S01877). Entscheidungslog 2026-08-27.
--
-- Rein vorwärts und idempotent: eine Sequenz wird nur bewegt, wenn sie
-- hinter dem höchsten vorhandenen Beleg ihres Musters steht — auf frischen
-- Instanzen ein No-Op. Rückwärts (etwa nach demodaten_loeschen, das Tabellen
-- UND Sequenzen gemeinsam zurücksetzt) wird nie gestellt.
do $$
declare
  k record;
  v_prefix   text;
  v_max      bigint;
  v_naechste bigint;
begin
  for k in
    select * from (values
      ('sale',     'sales_orders'),
      ('purchase', 'purchase_orders'),
      ('mo',       'manufacturing_orders')
    ) as t(code, tabelle)
  loop
    select prefix into v_prefix from sequences where code = k.code;
    if v_prefix is null then continue; end if;

    execute format(
      $sql$select coalesce(max((regexp_match(number, '^' || %L || '([0-9]+)$'))[1]::bigint), 0)
           from %I$sql$,
      v_prefix, k.tabelle) into v_max;

    execute format(
      'select case when is_called then last_value + 1 else last_value end from %I',
      'seq_' || k.code) into v_naechste;

    if v_max >= v_naechste then
      perform setval('seq_' || k.code, v_max, true);
      raise notice 'Nummernkreis %: Sequenz von % auf % gestellt (weiter bei %)',
        k.code, v_naechste, v_max, v_prefix || lpad((v_max + 1)::text, 5, '0');
    end if;
  end loop;
end $$;
