-- ============================================================================
-- 0118 — Einrichtungsaufgaben: Rechnungsausgang heute aus sevDesk, nicht aus
-- einer Shopify-App (Korrektur, Entscheidungslog 2026-10-16)
--
-- Der Betreiber stellt Ausgangsrechnungen heute mit sevDesk; die übrigen
-- Transaktionen laufen über ein weiteres Werkzeug (Pathway). 0116 und 0117
-- sprachen von einer „Shopify-Rechnungs-App" — die Schlüssel bleiben (sie
-- hängen an bestehenden Aufgaben), Titel und Beschreibung werden berichtigt,
-- offene Aufgaben spiegeln den neuen Text. Keine Datenlöschung.
-- ============================================================================

update einrichtungsaufgaben set
  titel = 'sevDesk-Rechnungsausgang abschalten',
  beschreibung = 'Ab dem Stichtag entsteht die Rechnung in KRNL mit der Lieferung. Den Rechnungsausgang in sevDesk beenden (keine neuen Rechnungen und Gutschriften mehr dort anlegen, Automatiken aus), sonst bekommt der Kunde zwei Rechnungen mit zwei Nummernkreisen. sevDesk bleibt für die Historie lesbar.'
where schluessel = 'shopify_rechnungsapp';

update einrichtungsaufgaben set
  titel = 'Nummernkreise RE-/GU- auf die nächste freie sevDesk-Nummer setzen',
  beschreibung = 'KRNL nummeriert Rechnungen und Gutschriften ab dem Stichtag selbst. Damit die Nummern lückenlos an sevDesk anschließen: in sevDesk die letzte Rechnung und Gutschrift nachsehen (zuletzt bekannt RE-7812 und GU-1416) und unter Einstellungen → Belege → Nummernkreise die nächste Nummer eintragen (z. B. 7813 und 1417).'
where schluessel = 'rechnung_nummernkreis';

update einrichtungsaufgaben set
  titel = 'Rechnungs-Probelauf auswerten: Testrechnungen mit sevDesk vergleichen, dann löschen und scharf schalten',
  beschreibung = 'Die Rechnung läuft im Probelauf parallel zum Rechnungsausgang in sevDesk: Testrechnungen (PROBE-RE-…) entstehen mit jeder Lieferung, zählen aber nirgends. Unter Verkauf → Rechnungen → Probelauf die Beträge je Bestellung mit dem Shop-Gesamtbetrag und stichprobenartig mit der sevDesk-Rechnung vergleichen; Abweichungen melden. Wenn alles stimmt: Nummernkreise RE-/GU- und Firmendaten prüfen, Probelauf löschen, unter Einstellungen → Belege auf „scharf" stellen und den sevDesk-Rechnungsausgang abschalten.'
where schluessel = 'rechnung_probelauf';

update einrichtungsaufgaben set
  beschreibung = 'Kontenrahmen (SKR03 vorbelegt, SKR04 möglich), Debitoren-Sammelkonto und Erlöskonten je Steuersatz unter Einstellungen → Belege → Kundenrechnungen eintragen; danach den ersten Buchungsstapel (Verkauf → Rechnungen → DATEV) zur Probe übergeben. Vorher mit der Steuerberatung klären, wer die Ausgangsrechnungen künftig an DATEV liefert — der KRNL-Buchungsstapel oder weiterhin Pathway (heute laufen die Transaktionen dort) — damit nichts doppelt gebucht wird.'
where schluessel = 'datev_konten';

-- Offene Aufgaben zeigen den berichtigten Text; erledigte bleiben, wie sie waren.
update aufgaben a set
  titel = e.titel,
  beschreibung = e.beschreibung
from einrichtungsaufgaben e
where a.einrichtung_schluessel = e.schluessel
  and a.erledigt_am is null
  and e.schluessel in ('shopify_rechnungsapp', 'rechnung_nummernkreis', 'rechnung_probelauf', 'datev_konten');
