# Einstellungen

Die Einstellungen sind die **Konfiguration der Instanz** — nur für
Administratoren (Bereich `einstellungen`). Aufgebaut als **ein Bereich je
Thema** mit linker, gruppierter Unternavigation (auf dem Telefon als
Chip-Leiste); die Landkarte steht in
`src/modules/einstellungen/bereiche.ts` und ist die einzige Liste — die
Navigation, die Seitenköpfe (`EinstellungenKopf`) und der Wächter
`tests/einstellungen.test.ts` lesen sie. Entscheidungslog 2026-09-26.

Nicht hier: die **persönlichen** Einstellungen (zweiter Faktor, Backup-Codes,
vertraute Geräte) unter Konto & Sicherheit (`/konto`, jede Rolle), die
**Abläufe** selbst unter Prozesse (`/prozesse`) und der **Betrieb** der
Anbindungen (Outbox, Webhooks, Protokoll, Dienste-Wächter) im
Ereignis-Monitor (`/integrationen`).

## Landkarte

| Gruppe | Bereich | Pfad | Was | Gespeichert in | Registry-Aktion(en) |
|---|---|---|---|---|---|
| Organisation | Firma | `/einstellungen` | Firmendaten = Absender auf Labels, Belegen, Mails; „Einrichtung erneut ansehen" | `settings.company` | `einstellungen.firma_speichern` |
| | Benutzer | `/einstellungen/benutzer` | Konten, Rollen, Befugnisse, Passwort- und 2FA-Reset | `users` | `einstellungen.benutzer_*` |
| | Sicherheit | `/einstellungen/sicherheit` | Pflicht für den zweiten Faktor, Konten ohne 2FA, Regeln der Anmeldung (Info) | `settings.sicherheit` | `einstellungen.sicherheit_setzen` |
| | Stammdaten | `/einstellungen/stammdaten` | Produktkategorien, Steuern, Zahlungsbedingungen, Tags (löschen mit Rückfrage) | `product_categories`, `taxes`, `payment_terms`, `tags` | `einstellungen.kategorie_anlegen`, `…steuer_anlegen`, `…zahlungsbedingung_anlegen`, `…tag_loeschen` |
| Abläufe | Belege & Freigaben | `/einstellungen/belege` | Sperren beim Bestätigen, Freigabegrenze Einkauf, Nummernkreise (nur lesen) | `settings.sales`, `settings.purchase`, `settings.freigaben` | `einstellungen.belegverhalten_setzen`, `einstellungen.freigaben_setzen` |
| | Versand & Druck | `/einstellungen/versand` | Labelformat, Druckweg (PDF oder Druckbrücke), Agenten-Stand | `settings.dhl.print_format`, `settings.druckbruecke` | `einstellungen.versand_vorgaben_setzen`, `einstellungen.druckbruecke_setzen` |
| | Versandregeln | `/einstellungen/versandregeln` | Produkt/Versandart je Bedingung, von oben nach unten | `shipping_rules` | `versand.versandregel_*` |
| | Kartonagen | `/einstellungen/kartonagen` | Verpackungen, Gewicht, Verbrauch | `packagings` | `versand.kartonage_*` |
| | Finanzen | `/einstellungen/finanzen` | Stellschrauben der Cashflow-Prognose (14 Felder) | `settings.finanzen` (Merge) | `einstellungen.finanz_parameter_setzen` |
| Anbindungen | Schnittstellen | `/einstellungen/anbindungen` | Shopify lesen/schreiben | `settings.shopify.modus` | `einstellungen.shopify_modus_setzen` |
| | Benachrichtigungen | `/einstellungen/benachrichtigungen` | Telegram: was gemeldet wird, Test, Chat-IDs, letzte Meldungen | `settings.benachrichtigungen` | `einstellungen.benachrichtigungen_setzen`, `…telegram_test`, `…telegram_chats` |
| | KI-Modelle | `/einstellungen/ki` | Modell je KI-Ebene | `settings.ki_modelle` | `einstellungen.ki_modelle_setzen` |
| Verwaltung | Nutzung | `/einstellungen/nutzung` | Monatsbericht (Nutzer, Belege, KI) — Bericht, keine Einstellung | — | — |
| | Registrierungen | `/einstellungen/registrierungen` | Posteingang der öffentlichen Startseite | `registrierungen` | `einstellungen.registrierung_status` |
| | Gefahrenzone | `/einstellungen/gefahrenzone` | Stufe 1 Betriebsdaten löschen, Stufe 2 Werkszustand (Bestätigungswort) | — | `einstellungen.betriebsdaten_loeschen`, `einstellungen.werkszustand` |

**Rechte:** Seit dem Umzug der Stammdaten-Konfiguration (2026-09-26) legen
nur Administratoren Kategorien, Steuern und Zahlungsbedingungen an — vorher
durfte es jede Rolle mit Schreibrecht auf Produkte. `/produkte/konfiguration`
leitet weiter; der Knopf auf der Produktliste erscheint nur für Admins.

## Regeln

- **Zugangsdaten sind Umgebungsvariablen, Verhalten ist `settings`.** API-
  Schlüssel, Passwörter und Tokens externer Dienste stehen in Vercel bzw.
  `.env`, nie in der Datenbank; die Einstellungen zeigen nur, ob sie da sind.
  Ausnahme mit Begründung: das Agent-Token der Druckbrücke (Entscheidungslog
  2026-08-27).
- **Jeder Schreibweg über die Registry** (`nurAdmin`, `prozessfrei`,
  `bindung 'frei'`), gespeichert per **Merge** — ein Formular überschreibt
  nie Schlüssel, die es nicht kennt. Der Wächter verbietet direkte
  `settings`-Schreiber in `src/app` (einzige Ausnahme: der Heartbeat der
  Druck-Agenten, `api/druck/abholen`).
- **Ein Bereich je Thema, eine Karte je Einstellung**: Titel ohne Klammer-
  Erklärung, Formular, Speichern, darunter ein Satz zur Wirkung („gilt
  sofort", „ab dem nächsten Label"). `notice` nur für Zustände und
  Warnungen, gespeicherte Zustände als Leuchte plus Wort (`Zustand`).
- **Keine toten Felder.** Das frühere „Standardprodukt" (`settings.dhl.
  default_product`) wurde entfernt — es wurde nirgends gelesen; das Produkt
  kommt aus den Versandregeln bzw. der Zielzone. Der Wert bleibt in der
  Datenbank liegen und stört nicht.
- **Destruktives nur in der Gefahrenzone**, immer zuletzt in der Navigation,
  bestätigt durch ein eingetipptes Wort, das das Schema prüft.

## Neue Einstellung — Checkliste

1. Registry-Aktion in `src/modules/prozesse/registry/einstellungen.ts`
   (Schema, `formdata`, `revalidate` auf den Bereichspfad), Ausführung in
   `einstellungen-ausfuehren.ts` (Merge über `einstellungMergen`), Eintrag im
   Dispatch `src/modules/prozesse/ausfuehren.ts`.
2. Karte im passenden Bereich — oder, für ein neues Thema, eine neue Seite
   mit `<EinstellungenKopf href=…>`, eigenem `requireArea('einstellungen')`,
   Eintrag in `bereiche.ts` und in `src/modules/befehle.ts`.
3. Zeile in der Landkarte oben; Leser der Einstellung in der Fachdoku.
