/**
 * Kompakte Schemabeschreibung für den KI-Agenten. Manuell gepflegt —
 * bei Schemaänderungen bitte mitziehen (Quelle: src/db/migrations/).
 */
export const SCHEMA_DOKU = `
## Datenmodell (PostgreSQL)

Alle IDs sind UUIDs. Zeitstempel: timestamptz. Mengen: numeric.

### Stammdaten
- **partners**: Kunden & Lieferanten. Spalten: name, is_company, is_customer, is_vendor, email, phone, street, house_number, zip, city, country_code, vat, active.
- **uoms**: Maßeinheiten (name, category, factor). Umrechnung: uom_convert(qty, von_uom_id, nach_uom_id).
- **product_templates**: Produkte. name, uom_id, list_price (VK), standard_cost (Einstand), weight_g, can_be_sold, can_be_purchased, type ('goods'|'service'), route_manufacture, route_mto, route_buy, active.
- **product_variants**: Varianten je Template (template_id). sku, barcode, display_name, price_extra, active. Anzeigename: variant_display_name(variant_id).
- **product_attributes / product_attribute_values**: Attribute (z. B. Farbe) und Werte (z. B. Weiß).
- **product_template_attribute_values (ptav)** & **product_variant_attribute_values**: verknüpfen Varianten mit Attributwerten.
- **vendor_prices**: Lieferantenpreise je Template (vendor_id → partners, price, discount, lead_time_days, min_qty, date_start, date_end).
- **product_categories**: Produktkategorien (name, parent_id, full_path). **taxes**: Steuersätze (name, amount, type_tax_use 'sale'|'purchase'). **payment_terms**: Zahlungsbedingungen inkl. Skonto. **incoterms**: Lieferbedingungen.
- **tags** (kind 'partner'|'product'|'sale'|'repair') mit den Verknüpfungen partner_tag_links, product_tag_links, sales_order_tag_links, repair_order_tag_links.

### Lager (Bewegungs-Ledger — Kernprinzip: jede Bestandsänderung ist eine Zeile in stock_moves)
- **stock_locations**: Orte, full_path z. B. 'WH/Stock', 'Virtuell/Produktion', 'Virtuell/Inventurdifferenz', 'Virtuell/Ausschuss', 'Partner/Kunden', 'Partner/Lieferanten'.
- **stock_moves**: variant_id, qty (Soll), qty_done (Ist), src_location_id, dest_location_id, state ('draft','waiting','confirmed','assigned','done','cancel'), reference (z. B. 'Fertigmeldung', 'Komponentenverbrauch', 'Inventur'), date_done, picking_id, production_id (→ manufacturing_orders), unbuild_id, repair_id, inventory_id.
- **stock_pickings**: Transfers. number ('WH/IN/…', 'WH/OUT/…', 'WH/INT/…', 'WH/REP/…'), operation_type_id, state, partner_id, origin_model/origin_id (z. B. 'sales_order'), backorder_of_id, date_done.
- **Erwarteter Zulauf** („wann kommt X an?"): OFFENE Empfänge zählen — stock_pickings mit operation_types.kind = 'receipt' und state not in ('done','cancel'), Positionen/Termine über stock_moves + scheduled_date. NICHT am Bestellstatus festmachen: eine purchase_order kann 'done' sein, während ihr Wareneingang noch aussteht. Schnellprüfung je Variante: incoming_qty(variant_id).
- **stock_quants**: aktueller Bestand je (location_id, variant_id): on_hand, reserved. Nur über Funktionen gepflegt — für Auswertungen besser die Helfer nutzen:
  on_hand_qty(variant_id), free_to_use(variant_id), incoming_qty(variant_id), outgoing_qty(variant_id), forecasted_qty(variant_id).
- **inventory_counts**: Inventuren (counted_qty, book_qty, applied_at).
- **stock_orderpoints**: Meldebestände (variant_id, location_id, min_qty, max_qty, qty_multiple, route 'buy'|'manufacture', snoozed_until). Vorschläge: orderpoint_suggestions().

### Los- und Seriennummern
- **product_templates.tracking**: 'none'|'lot'|'serial'. Helfer: product_tracking(variant_id).
- **stock_lots**: Lose/Seriennummern (variant_id, name, ref, note). **move_lot_assignments**: (move_id, lot_id, qty) — welche Nummer in welcher Bewegung. **stock_lot_quants**: Bestand je (location_id, variant_id, lot_id).
- Rückverfolgung: von move_lot_assignments über stock_moves auf picking_id / production_id joinen.

### Bestandsbewertung (gleitender Durchschnitt / AVCO)
- **stock_valuation_layers**: unveränderliche Wertschichten. variant_id, move_id, layer_type ('receipt','issue','landed_cost','revaluation','production'), quantity (+Zugang/−Abgang), unit_cost, value, qty_after, value_after, note, created_at.
- **product_variants.moving_avg_cost / valued_qty / valuation_total**: fortgeschriebener Durchschnittspreis und Bestandswert. View **stock_value** (variant_id, product, sku, on_hand, valued_qty, moving_avg_cost, valuation_total, qty_difference).
- **landed_costs** + **landed_cost_allocations**: Einstandsnebenkosten (Fracht, Zoll) verteilt nach basis 'weight'|'value'|'quantity'.
- **currencies** / **exchange_rates**: Fremdwährung; Kurs zum Stichtag: exchange_rate_at(code, datum). purchase_orders.exchange_rate friert den Kurs bei Bestätigung ein.

### Verkauf
- **sales_orders**: number ('S00001'), partner_id, state ('draft','sent','sale','cancel'), locked, delivery_status ('nothing','partial','full'), invoice_status, order_date, source ('manuell'|'shopify'), shopify_order_id/name, ship_*-Adressfelder, origin_model/origin_id/origin_label (Herkunftsbeleg, z. B. ein Vorgang — Grundlage der Teilprozess-Verkettung). Summen: sales_order_total(order_id) → (net, tax, gross).
- **sales_order_lines**: order_id, variant_id, name, qty, qty_delivered, uom_id, price_unit, discount, tax_rate. Netto je Zeile: sale_line_subtotal(zeile).

### Fertigung
- **boms**: Stücklisten je Template (template_id, qty, bom_type 'manufacture'|'kit', consumption 'blocked'|'allowed'|'warning'). Auflösung je Variante: resolve_bom(variant_id) → bom_id (nur 'manufacture'), resolve_kit(variant_id) → bom_id (nur 'kit'/Phantom).
- **bom_lines**: Positionen (component_variant_id, qty, uom_id, issue_method 'backflush'|'manual'). Variantenfilter: bom_line_variant_filters (bom_line_id, ptav_id) — Position gilt nur für Varianten mit dem Attributwert. Einstufig gefilterte Liste: bom_components_for_variant(bom_id, variant_id); **mehrstufig mit aufgelösten Baugruppen: bom_explode(bom_id, variant_id, menge)** → (component_variant_id, qty, uom_id, issue_method, depth, phantom_path).
- **work_centers**: Arbeitsplätze (code, name, cost_per_hour, capacity, time_efficiency). **bom_operations**: Arbeitsgänge der Stückliste (name, work_center_id, duration_minutes je Referenzmenge, setup_minutes je Auftrag).
- **mo_operations**: Arbeitsgänge des Auftrags (mo_id, name, work_center_id, cost_per_hour als Schnappschuss, duration_expected, duration_real, state 'pending'|'progress'|'done'|'cancel', date_start, date_done, user_id). Lohnkosten: mo_labor_cost(mo_id).
- **manufacturing_orders**: number ('MO/00001'), variant_id, qty_to_produce, qty_produced, state ('draft','confirmed','progress','to_close','done','cancel'), sales_order_id, backorder_of_id, date_done, material_cost, labor_cost, unit_cost. Komponentenbedarf = stock_moves mit production_id und reference='Komponentenverbrauch' (mit issue_method und phantom_path); Fertigmeldung = reference='Fertigmeldung'.
- View **production_cost**: je erledigtem Auftrag number, product, qty_produced, material_cost, labor_cost, total_cost, unit_cost, minutes.
- **unbuild_orders**: Demontage (variant_id, qty, state).

### Einkauf
- **purchase_orders**: number ('P00001'), vendor_id → partners, state ('draft','sent','purchase','done','cancel'), order_deadline, expected_arrival (ETA geschätzt), eta_confirmed (vom Lieferanten bestätigt), carrier, tracking_number, confirmed_at, created_at, billing_status, freigegeben_von/freigegeben_am (Bestellfreigabe). billing_status = 'waiting' zählt nur als offener Posten, wenn der Rechnungsschritt Teil des Ablaufs ist — prozessschritt_aktiv('einkauf_wareneingang_rechnung','rechnung') prüft das (false = Abrechnung läuft extern, 'waiting' ist dann Normalzustand). Freigabepflicht ab Limit: einkauf_freigabe_noetig(order_id); das Limit steht in settings key 'freigaben' (einkauf_limit, netto; fehlt = keine Pflicht).
- **purchase_order_lines**: order_id, variant_id, qty, qty_received, qty_billed, uom_id, price_unit.
- **vendor_bills**: Lieferantenrechnungen (number 'BILL/…', vendor_id, purchase_order_id, state 'draft'|'posted'|'paid'|'cancel', total).
- **vendor_bill_lines**: Positionen.

### Personal
- **employees**: Mitarbeiter (number 'MA0001', name, barcode = Ausweis, job_title, department, employment_type 'full_time'|'part_time'|'mini_job'|'temp'|'apprentice', hourly_cost = Personalkostensatz je Stunde, weekly_hours, vacation_days, hire_date, exit_date, active, user_id → users).
- **time_entries**: Zeiterfassung (employee_id, kind 'attendance'|'production', mo_operation_id, started_at, ended_at, break_minutes, minutes = Nettodauer, hourly_cost als Schnappschuss). Helfer: employee_minutes(employee_id, von, bis). View **employees_present** (wer ist gerade angemeldet), View **time_sheet** (Minuten und Kosten je Mitarbeiter, Tag und Art).
- **shift_templates** (code, name, start_time, end_time, break_minutes) und **shift_assignments** (employee_id, template_id, work_center_id, starts_at, ends_at, state 'draft'|'published'|'cancel'). Überschneidungen sind per Ausschluss-Constraint unmöglich.
- **absences**: Abwesenheiten (kind 'vacation'|'sick'|'training'|'unpaid'|'other', starts_on, ends_on, half_day, state 'requested'|'approved'|'rejected'|'cancel', reason, decided_by, decided_at). Arbeitstage: absence_days(id).

### Reparatur & Versand
- **repair_orders**: number ('RMA/…'), partner_id, variant_id, state ('new','confirmed','under_repair','repaired','cancel').
- **repair_parts**: Teile (kind 'add'|'remove'|'recycle', variant_id, qty).
- **shipments**: DHL-Sendungen (shipment_number, picking_id, sales_order_id, state 'created'|'manifested'|'transit'|'delivered'|'failure'|'cancelled', tracking_url).
- **shipping_ready** (View): versandbereite Lieferungen (Lieferung 'assigned', keine offenen MOs).

### Kennzahlen (materialisierte Sichten, per Cron neu berechnet)
- **mv_stock_value_history**: Bestandsmenge und -wert je Variante zum Monatsende (monat, variant_id, qty_end, value_end).
- **mv_contribution_margin**: Deckungsbeitrag je Monat und Variante (monat, variant_id, qty, revenue, cost). Realisiert bei der Auslieferung, Retouren gegengerechnet.
- **mv_inventory_turnover**: je Variante on_hand, value_now, avg_value_12m, cogs_12m, revenue_12m, margin_12m, turnover (Umschlag), daily_use, days_of_supply (Reichweite in Tagen).
- **mv_supplier_otd**: Liefertreue je Lieferant und Monat (vendor_id, vendor, lines, delivered, on_time, overdue, avg_delay_days, qty_ordered, qty_received).
- **mv_rma_analysis**: RMA je Monat und Variante (rma_count, repaired, cancelled, parts_used, qty_delivered, rma_rate in Prozent).
- **mv_labor_hours**: Minuten und Lohnkosten je Monat, Mitarbeiter, Art und Arbeitsplatz.
- Stand der Berechnung: settings.value ->> 'refreshed_at' für key = 'analytics'.

### Prozesse & Vorgänge (das ERP ist prozessgetrieben — Abläufe sind Daten)
- **prozesse**: Prozesskopf (code z. B. 'einkauf_wareneingang_rechnung', name, bereich, aktiv). **prozess_versionen** (prozess_id, nr, aktiv) mit **prozess_schritte** (schluessel, art 'start'|'aktion'|'ende'|'teilprozess', aktion = Registry-Name, zustand, optional, befugnis) und **prozess_uebergaenge** (von/nach, bedingung).
- **prozess_instanzen**: laufende Assistenten (prozess_id, schritt, status 'laeuft'|'fertig'|'abgebrochen', daten jsonb mit beleg_id, gestartet_von).
- **prozess_modelle** (code → Tabelle, Statusspalte, Detailroute), **prozess_routen** (Einstiegsrouten), **prozess_pakete** (Prozess-Pakete fürs Geschäftsmodell, prozess_codes[]), **prozess_overrides** (Laufzeit-Anpassungen). Ist ein Schritt Teil des aktiven Ablaufs: prozessschritt_aktiv(code, schluessel).
- **vorgaenge**: generische Vorgänge des Chamäleon-Baukastens (nummer 'VG/…', art, titel, status, partner_id, zusatz jsonb, origin_model/origin_id/origin_label — ein Vorgang kann selbst aus einem anderen Beleg entstehen). **feld_definitionen**: eigene Zusatzfelder ohne Migration (modell, name, label, typ, pflicht, auswahl, sichtbar_in). Sie gehören zu einem PROZESS (prozess_code) und optional nur zu bestimmten Schritten (schritte text[]); prozess_code null = für alle Belege des Modells. Werte landen im zusatz-jsonb und sind in Bedingungen als zusatz.name ansprechbar.
- **bug_reports**: Tickets (number 'BUG/…', titel, beschreibung, status 'offen'|'in_arbeit'|'behoben'|'geschlossen', schwere, seite, commit_sha).

### Versand-Extras & Shopify-Abgleich
- **operation_types**: Transferarten (name, kind 'receipt'|'delivery'|'internal'|'repair', sequence_code). **warehouses**: Lagerhäuser (code, name).
- **packagings**: Kartonagen (name, Innenmaße, max_weight_g, kosten). **shipping_rules**: Versandregeln zur Kartonagen-/Produktwahl (priority, bedingungen, packaging_id). **return_labels**: Retourenlabels (shipment_number, sales_order_id, state).
- **shopify_unmatched_lines**: Klärliste nicht zuordenbarer Shopify-Positionen (order_name, sku, title, resolved_at). **shopify_inventory_state** / **shopify_sync_state**: Abgleich-Zustand (variant_id bzw. Schlüssel, zuletzt gemeldete Menge/Cursor).
- **uom_categories**: Einheitenkategorien. **product_template_attribute_lines**: welche Attribute ein Template nutzt. **bom_byproducts**: Kuppelprodukte einer Stückliste (variant_id, qty).

### Sonstiges
- **audit_log**: Verlauf je Datensatz (model, record_id, kind 'state'|'note'|'email'|'error', message, actor, created_at). model='ki' zählt KI-Nutzung (Chat-Fragen, ausgeführte Aktionen). Monatsübersicht der Nutzung: nutzungsbericht(monate) → (monat, aktive_nutzer, belege, ki_fragen, sprachsitzungen).
- **sequences**: Nummernkreise. **integration_jobs**: Outbox für Shopify/E-Mail (nicht abfragbar).
- **api_transactions**: Protokoll aller Aufrufe an Shopify/DHL/Mail (system, kind, reference, ok, status_code, error, duration_ms, created_at).
- **registrierungen**: Interessenten von der öffentlichen Startseite (firma, ansprechpartner, email, telefon, nutzer, heutiges_system, ablauf, quelle, status 'offen'|'kontaktiert'|'erledigt'|'abgelehnt', notiz, bearbeitet_am, bearbeitet_durch, created_at). Einziger Schreibweg ohne Sitzung.
- **odoo_verweise**: Herkunft der Datenübernahme aus Odoo 18 (odoo_tabelle, odoo_id, krnl_tabelle, krnl_id, lauf, created_at; PK odoo_tabelle+odoo_id). Beantwortet „woher stammt dieser Datensatz?" — geschrieben nur vom Importskript, nie im Betrieb.
- **druckauftraege**: Warteschlange der Druckbrücke (art 'label'|'zettel', shipment_id bzw. mo_id, ziel 'labeldrucker'|'zetteldrucker', status 'offen'|'gedruckt'|'fehler', fehler, created_at, gedruckt_am) — Agenten auf den Arbeitsplatz-PCs holen die Ziele ab, die sie bedienen, drucken und quittieren.

Konventionen: Geldwerte sind netto in EUR, sofern nicht anders benannt. 'state' immer als Text vergleichen. Monatsauswertungen mit date_trunc('month', …).
`

/**
 * Finanzmodul-Schema — wird dem Systemprompt NUR angehängt, wenn der Fragende
 * den Bereich Finanzen sehen darf (Admin oder Befugnis finanzen:zugriff).
 * Ohne die Berechtigung sind die Tabellen zusätzlich per SQL-Sperre blockiert.
 */
export const SCHEMA_DOKU_FINANZEN = `
### Finanzen (Cashflow, Verträge, Darlehen, Steuern, Prognose)
- **bankkonten** (name, iban, waehrung, aktiv) und **kontostaende** (bankkonto_id, stichtag, saldo) — manuelle Kontostands-Anker.
- **Liquide Mittel / Kassenstand: finanz_saldo()** → je Konto (bankkonto_id, name, saldo, stichtag); Summe über alle Zeilen = liquide Mittel gesamt. Saldo = letzter Anker + alle nicht stornierten Zahlungen danach.
- **zahlungen**: das Ist-Register. nummer ('ZA/…'), richtung 'ein'|'aus', betrag, waehrung, kurs, **betrag_eur** (Rechenwahrheit), gezahlt_am, bankkonto_id, quelle ('vendor_bill','po_rate','vertrag','darlehen','darlehen_rate','steuer','manuell'), vendor_bill_id, zahlplan_rate_id, vertrag_id, darlehen_id, steuerzahlung_id, partner_id, verwendungszweck, storniert_am (Storno statt Löschen — stornierte immer ausfiltern).
- **zahlplan_raten** je Bestellung: purchase_order_id, bezeichnung, anteil_pct XOR betrag, ausloeser ('bestellung','verschiffung','ankunft','termin'), versatz_tage, termin, bezahlt_am. Helfer: zahlplan_betrag(rate), zahlplan_faelligkeit(rate); offener Rechnungsrest inkl. Raten-Anrechnung: vendor_bill_offen(bill_id).
- **Fällige Zahlungen: finanz_faellig(bis_datum)** → (quelle, ref, label, partner, faellig_am, betrag_eur, richtung, link) — offene Raten, Rechnungen, Vertrags-, Darlehens- und Steuertermine in einer Liste.
- **vertraege**: Fixkosten (nummer 'VT/…', name, kategorie, partner_id, betrag BRUTTO je Intervall, waehrung, intervall 'monatlich'|'quartalsweise'|'jaehrlich', zahltag, beginn, ende, laufzeit_monate, kuendigungsfrist_monate, gekuendigt_zum, status 'aktiv'|'gekuendigt'|'beendet'). Helfer: vertrag_naechstes_kuendbar_zum(v), vertrag_kuendigung_ansteht(id), vertrag_zahlungen_bis(id, bis).
- **darlehen** (nummer 'DA/…', name, betrag, zinssatz_pct p. a., art 'annuitaet'|'rate'|'endfaellig', auszahlung_am, laufzeit_monate, tilgungsfrei_monate, zahltag, bankkonto_id, status 'geplant'|'laufend'|'getilgt') und **darlehen_raten** (nr, faellig_am, zins, tilgung, restschuld, bezahlt_am). Restschuld = restschuld der letzten bezahlten Rate bzw. betrag.
- **steuerzahlungen**: art 'ust'|'gewst'|'kst'|'sonstige', zeitraum_von/bis, bezeichnung, betrag (>0 Zahllast, <0 Erstattung), faellig_am, quelle, bezahlt_am. USt-Schätzung aus Belegen: ust_zahllast_vorschlag(monat) → (umsatzsteuer, vorsteuer, zahllast, faellig_am).
- **umsatzplan**: Planumsatz netto je (monat, szenario 'best'|'base'|'worst'), quelle 'vorschlag'|'manuell'.
- **Cashflow-Prognose: finanz_prognose(szenario, raster 'woche'|'monat', perioden)** → je Periode (periode_start, periode_ende, anfangssaldo, einzahlungen, aus_bestellungen, aus_vertraegen, aus_darlehen, aus_steuern, aus_variable_quote, auszahlungen, endsaldo). **Fremdkapitalbedarf: finanz_unterdeckung(szenario)** → (min_saldo, min_periode, fremdkapitalbedarf).
- Einstellungen (Quoten, Sätze, Zahltage): finanz_einstellung(schluessel, standard) — z. B. finanz_einstellung('wareneinsatz_pct', 30).
`
