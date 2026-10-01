# Go-Live-Plan: Odoo und Sendcloud ablösen

Alles, was vor dem Stichtag eingerichtet, entschieden oder geprüft sein
muss, an einem Ort — damit nichts im Chat liegen bleibt. Der Plan ist eine
Checkliste: abgehakt wird in dieser Datei, im selben Commit wie die
Umsetzung. Die eigentliche Datenübernahme steht im
[Cutover-Runbook](migration-odoo.md#cutover-runbook-stichtag), die
Variablen im Detail in [vercel-supabase.md](vercel-supabase.md); dieser
Plan verweist dorthin, statt es zu wiederholen.

**Wer:** „Betreiber" ist die Person mit Zugang zu Vercel, Supabase, DHL
und Shopify. „KRNL" sind Aufgaben im Code, die vor dem Stichtag fertig
sein müssen.

Stand: 2026-10-01 — abgeglichen mit Prod (Dienste-Wächter, Datenbank,
Supabase-Logs; Vercel-Variablen sieht KRNL nicht, die stehen offen, wenn
sie sich nicht an einer Wirkung ablesen lassen). Erledigt seit Aufstellung
(2026-09-18): Region Frankfurt, Sicherheits-Header, Login-Drossel, Cron
fail-closed, Tracking über Parcel DE Tracking, Shopify-Lesemodus und
Probelauf, Odoo-Stücklisten, Druckbrücke, Label bucht aus, ein Scanfeld,
Datenbank-TLS im Code, Konten löschen.

**Kurzlage 2026-10-01:** DHL, Shopify (Probelauf), KI, Sprache,
Druckbrücke und Telegram melden grün; Mail und Google sind nicht
eingerichtet. Offen vor dem Stichtag vor allem: Mail, PITR, Konten/2FA
(nur ein Admin hat den zweiten Faktor), DHL-Retouren-Empfänger,
Retouren-/Reparaturtest — dann Stichtag nach Runbook. Im Code erledigt
(2026-10-01): Zweitangebote im Bestand und „Adresse prüfen" (nach dem
Deploy einmal gegenprüfen, §5 und §6). `ZWEIFAKTOR_SCHLUESSEL` lässt sich
seit 2026-10-01 gefahrlos nachträglich setzen.

## 1. Geheimnisse und Zugänge (Betreiber, Vercel → Production)

Nichts davon gehört ins Repository. Werte kommen aus den jeweiligen
Portalen; hier stehen nur die Namen und woher sie kommen.

- [x] `CRON_SECRET` setzen — der Endpunkt antwortet auf Vercel ohne
      Secret mit 401, das heißt: **kein einziger Cron läuft, bis der Wert
      steht** (Outbox, Webhooks, Shopify-Abgleich, Tracking, Aufräumen).
      Vercel schickt ihn bei eigenen Aufrufen automatisch als Bearer mit.
      *Stand 2026-10-01: gesetzt — Wächter und Shopify-Abgleich laufen im
      Takt (fail-closed, sonst liefe nichts).*
- [ ] `SESSION_SECRET` ist gesetzt und nicht der Wert aus einem Beispiel.
- [x] **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`): Bot beim
      @BotFather anlegen, Token setzen, dem Bot schreiben, dann unter
      Einstellungen → Benachrichtigungen „Chat-IDs ermitteln" und die ID
      setzen; „Testnachricht senden" muss auf dem Telefon ankommen. Ohne
      die beiden Werte werden Meldungen als „übersprungen" abgehakt.
- [ ] `ZWEIFAKTOR_SCHLUESSEL` setzen (eigener Zufallswert, `openssl rand -hex 32`):
      verschlüsselt die TOTP-Geheimnisse des zweiten Faktors. Fehlt er, nimmt
      KRNL `SESSION_SECRET`. Nachträglich setzen ist seit 2026-10-01
      gefahrlos: bestehende Einrichtungen werden weiter gelesen und beim
      nächsten Code umgeschlüsselt — niemand richtet neu ein.
- [x] **DHL** (alle aus der Produktions-App im DHL Developer Portal bzw.
      dem Geschäftskundenportal, Sandbox-Werte raus):
  - `DHL_API_BASE=https://api-eu.dhl.com`
  - `DHL_API_KEY`, `DHL_API_SECRET` — Key und Secret der Produktions-App
    (die mit Parcel DE Shipping, Returns und Tracking).
  - `DHL_GKP_USER`, `DHL_GKP_PASSWORD` — ein **Systembenutzer** aus dem
    Geschäftskundenportal, nicht das persönliche Login. Passwort läuft
    nach 365 Tagen ab: Erinnerung in den Kalender.
  - `DHL_BILLING_NUMBER` — die 14-stellige Abrechnungsnummer (EKP +
    Verfahren + Teilnahme) für Paket national; weitere Produkte ziehen
    ihre Nummer über die Versandregeln.
  - `DHL_RETURN_RECEIVER_ID` — die Retouren-Empfängerkennung aus dem
    Geschäftskundenportal (Standard `deu`).
  - `DHL_TRACKING_USER`, `DHL_TRACKING_PASSWORD`, `DHL_TRACKING_API`
    bleiben in Produktion **leer** (nur Sandbox bzw. Rückfall).
  - Voraussetzung: „Parcel DE Tracking" in der Produktions-App steht auf
    aktiv, nicht mehr auf pending. Bis dahin meldet der Tracking-Lauf
    einen Anmeldefehler im Ergebnis und sonst nichts.
  - *Stand 2026-10-01: Wächter grün, erstes echtes Label (WH/OUT/00003)
    erstellt, storniert und neu erstellt. Tracking-Freigabe noch prüfen.*
- [x] **Shopify**: App im Live-Shop anlegen (Dev Dashboard, Scopes laut
      [lokal-starten.md](lokal-starten.md)), dann `SHOPIFY_SHOP_DOMAIN`,
      `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
      `SHOPIFY_WEBHOOK_SECRET` — siehe
      [api-referenz/shopify.md](api-referenz/shopify.md). Die
      Schnittstelle liefert Bestellungen der letzten 60 Tage; die Historie
      davor kommt aus dem CSV-Export (Integrationen → Historie aus
      Shopify). **Gefahrlos vor dem Stichtag:** die Anbindung startet im
      Modus „nur lesen" (Staging) — Bestellungen und Produkte kommen
      herein, nichts geht hinaus, bis ein Admin unter Einstellungen →
      Schnittstellen auf „schreiben" stellt
      ([module/integrationen.md](module/integrationen.md)).
      *Stand 2026-10-01: App per Client-Credentials verbunden, Modus
      „Probelauf" (würde senden, sendet nichts — Debug-Box).*
- [ ] **Mail**: `RESEND_API_KEY`, `MAIL_FROM` mit verifizierter Domain
      (Shop-Domain anvil.gg — Kunden bekommen die Reparatur-Bestätigung von
      dieser Adresse), `REGISTRIERUNG_MAIL`. *Stand 2026-10-01: Wächter
      „unbekannt" — nicht eingerichtet.* Ohne anvil.gg-Absender sehen
      Kunden einen fremden Absender; `MAIL_FROM` gilt für alle Mails (auch
      an Lieferanten).
- [x] **KI** (optional): `ANTHROPIC_API_KEY`; `OPENAI_API_KEY` nur, wenn
      das Diktat gebraucht wird. *Stand 2026-10-01: KI und Sprache grün.*
- [ ] `INSTANZ_REGION="EU-Central · Frankfurt"` für die Anzeige.

## 2. Supabase (Betreiber)

- [x] Data API abschalten (Project Settings → Data API). Nichts in KRNL
      nutzt PostgREST; Migration 0074 hat die Rechte ohnehin entzogen.
      *Stand 2026-10-01: abgeschaltet.* Bekannte Supabase-Eigenheit: der
      abgeschaltete PostgREST läuft weiter und schreibt alle ~32 s
      „schema pg_pgrst_no_exposed_schemas does not exist" ins Log (rund
      220 Zeilen je Stunde) — harmlos, KRNL selbst hat dort keine Fehler.
      Abstellen laut Supabase-Troubleshooting mit einem leeren Schema:
      `create schema pgrst_no_exposed_schemas; alter role authenticator set
      pgrst.db_schemas = 'pgrst_no_exposed_schemas'; notify pgrst;` —
      *in Prod ausgeführt 2026-10-01 (auf Wunsch des Betreibers). Vor einem
      Wiedereinschalten der Data API zurücknehmen: `alter role authenticator
      reset pgrst.db_schemas; notify pgrst;`*
- [x] „Enforce SSL" einschalten (Database → Settings). Kein Zusatz in
  `DATABASE_URL`/`DIRECT_URL` nötig — KRNL verbindet seit 2026-10-01 von
  sich aus mit TLS (`src/db/ssl.ts`); erst deployen, dann einschalten.
  *Stand 2026-10-01: laut Betreiber eingeschaltet.*
- [ ] Point-in-Time-Recovery buchen — der Rollback-Pfad des Cutovers.
- [ ] Auftragsverarbeitungsvertrag (DPA) im Dashboard abschließen.
- [ ] Bekannt und akzeptiert: btree_gist liegt in public (einzige
      verbleibende Linter-Warnung; Umzug lohnt den Aufwand nicht).

## 3. Vercel (Betreiber)

- [x] Pro-Tarif — `vercel.json` hat sechs Cron-Einträge, zwei davon
      minütlich; der Hobby-Tarif erlaubt zwei tägliche. *Stand 2026-10-01:
      die Crons laufen im Minuten-/Fünfminutentakt.*
- [ ] Auftragsverarbeitungsvertrag (DPA) abschließen.
- [ ] Entscheidung Deployment Protection: **Vercel Authentication** vor
      die App (Ausnahmen `/api/webhooks/shopify` und `/api/cron`, siehe
      [vercel-supabase.md §6](vercel-supabase.md)) oder bewusst offen
      lassen, weil App-Anmeldung plus Login-Drossel tragen. Empfehlung:
      einschalten, solange /start nicht im eigenen Projekt läuft.
- [ ] Eigene Domain (z. B. erp.<firma>.de) statt `*.vercel.app`, HSTS
      kommt von Vercel mit.
- [x] Region Frankfurt (`regions: ["fra1"]`, verifiziert 2026-09-18).

## 4. Konten (Betreiber)

- [ ] Seed-Konto `admin@example.com` ersetzen: eigenes Admin-Konto
      anlegen, Seed-Konto löschen. Das Passwort des Seed-Kontos wurde am
      26.08.2026 geändert — bestätigen, dass das der Betreiber war.
      *Stand 2026-10-01: eigene Admin-Konten da, Seed-Konto deaktiviert.
      Löschen geht seit 2026-10-01 unter Einstellungen → Benutzer →
      „Löschen" (nach dem Deploy).*
- [ ] Benutzerkonten je Rolle anlegen (Odoo-Konten werden nicht
      migriert); Rollenmodell in
      [module/rollen-auswertungen-scanner-ki.md](module/rollen-auswertungen-scanner-ki.md).
      *Stand 2026-10-01: drei aktive Konten (zwei Admin, ein Lager).*
- [ ] **Zweiter Faktor ist Pflicht für alle** (Standard): jeder Benutzer
      braucht beim ersten Login nach dem Deploy eine Authenticator-App auf
      dem Telefon und richtet sie direkt ein — vorher ankündigen, Backup-
      Codes sichern lassen. Der Admin, der den Deploy macht, richtet als
      Erster ein (Seed-Konto eingeschlossen). Lockern geht unter
      Einstellungen → Sicherheit (`admins` / `freiwillig`).
      *Stand 2026-10-01: ein von drei aktiven Konten hat den zweiten Faktor
      eingerichtet.*

## 5. Versand fachlich (KRNL + Betreiber)

- [x] KRNL: Aktion „Adresse prüfen" (Shipping-API `validate=true`) am
      Verkaufsauftrag und am Packtisch. *Stand 2026-10-01: umgesetzt
      (`versand.adresse_pruefen`, [module/versand.md](module/versand.md)
      „Adresse prüfen") — Knopf am Verkaufsauftrag (Karte „Lieferadresse"),
      in der Versandliste (Spalte „Ziel") und im Packablauf des Scanfelds;
      derselbe Request wie das Label, ohne Label, Ergebnis „Adresse ok" oder
      die DHL-Beanstandungen in Klartext. Lehnt DHL ein Label wegen der
      Adresse ab, ist auch diese Meldung jetzt lesbar („PLZ passt nicht zum
      Ort" statt „consignee.postalCode: …"). Nach dem Deploy einmal an einer
      echten Lieferung prüfen (Betreiber).*
- [x] KRNL: Gewichte aus Shopify übernehmen prüfen (Versandgewicht =
      Warengewicht + Kartonage, [module/versand.md](module/versand.md)).
      *Stand 2026-10-01: der Import hatte keine Gewichte geholt. Jetzt
      Versand → „Gewichte fehlen" → „Gewichte aus Shopify übernehmen" bzw.
      je Artikel setzen; beim Packen fragt das Scanfeld fehlende Gewichte ab.*
- [ ] Betreiber: in Versand → „Gewichte fehlen" einmal „Gewichte aus Shopify
      übernehmen" ausführen, Rest von Hand setzen.
- [ ] Betreiber: Versandregeln und Abrechnungsnummern je Produkt
      (national, Kleinpaket, Europaket, International) hinterlegen.
      *Stand 2026-10-01: drei Versandregeln, noch keine Kartonagen.*
- [ ] Gemeinsam, erster echter Test mit Produktions-Keys: ein Label für
      eine reale Sendung erstellen, stornieren, im Geschäftskundenportal
      prüfen, dass der Storno ankommt. Danach ein Label, das wirklich
      verschickt wird, und nach ein bis zwei Stunden den Tracking-Lauf
      beobachten (Aktion „Tracking aktualisieren"). *Stand 2026-10-01:
      Label erstellt und storniert (WH/OUT/00003), Ersatz-Label erstellt
      und ausgebucht — Storno im Geschäftskundenportal und Tracking noch
      prüfen.*
- [ ] Ein Retourenlabel erzeugen und die Mail beim Kunden-Testkonto
      prüfen.
- [ ] Reparaturanfrage **im Shop** (App Proxy,
      [website.md „Im Shop (App Proxy)"](website.md)): eigene App
      „reparatur" nur mit `write_app_proxy`, App URL `https://anvil.gg`,
      nicht eingebettet, App Proxy `apps`/`reparatur` →
      `https://<erp-domain>/api/shopify/proxy` releasen und installieren,
      Berechtigung im Shop-Admin bestätigen, ihr Client Secret als
      `SHOPIFY_PROXY_SECRET` in Vercel; `/api/shopify/proxy` von der Deployment
      Protection ausnehmen; URL-Weiterleitung `/reparatur` →
      `/apps/reparatur` und Menüpunkt im Shop;
      `REPARATUR_SHOP_URL=https://anvil.gg/apps/reparatur` (alte Links auf
      `/service/reparatur` landen im Shop); `MAIL_FROM` mit anvil.gg-Absender
      (Resend-Domain verifiziert); `REPARATUR_MAIL` auf den
      Service-Posteingang. Testen: abgemeldet und angemeldet je eine Anfrage
      (Vorbelegung, Bestellnummern), `curl -sI https://anvil.gg/apps/reparatur`
      ohne verräterische Header, im ERP annehmen, Retourenlabel mit
      RMA-Nummer im Geschäftskundenportal sichtbar; Rückversand-Label aus
      einer Reparatur testen. Sendcloud-Retourenportal-Link ersetzen.
      *Stand 2026-10-01: App „reparatur" mit Proxy läuft — Shop vorerst auf
      www.nvil.gg, `https://www.nvil.gg/apps/reparatur` antwortet (Formular im
      Theme, keine verräterischen Header). Offen: `REPARATUR_SHOP_URL`,
      Weiterleitung und Menüpunkt, Mail-Absender, Testanfragen.*
- [x] Druckbrücke einrichten
      ([module/versand.md „Druckbrücke"](module/versand.md)): unter
      Einstellungen → Arbeitsplätze & Drucker Packtische, Montagetische,
      Drucker (Etikettenmaße messen) und Druckwege anlegen, je Drucker das
      Paket laden und am PC starten, an jedem PC oben im Kopf einmal den
      Arbeitsplatz wählen. *Stand 2026-10-01: zwei Drucker, Wächter grün.*

## 5b. Odoo-Stücklisten (selektiv, per API)

- [x] In Vercel `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` setzen
      (API-Schlüssel: Odoo → Einstellungen → Benutzer → Kontosicherheit),
      neu deployen; Einstellungen → Schnittstellen zeigt „Odoo" vollständig.
- [x] Einstellungen → Odoo-Übernahme → **Vorschau** gemeinsam durchgehen:
      fehlende SKUs, blockierte Stücklisten, Routen-Warnung (ab dann
      erzeugt jede Shopify-Bestellung einen Fertigungsauftrag).
- [x] **Übernehmen**, dann an zwei, drei Tastaturen die Stückliste prüfen
      (Karte „Vorschau je Variante"). *Stand 2026-10-01: übernommen, neun
      aktive Stücklisten; Fertigprodukt-Bestände zurückgenommen und
      Fertigungsaufträge für offene Aufträge nachgezogen (2026-09-30).*
- [ ] Doppelte Artikel (Shop ↔ Odoo) unter Einstellungen → Odoo-Übernahme
      zusammenführen (Vorschlagsliste prüfen, je Paar „Zusammenführen").

## 6. Shopify (im Runbook, Schritt 7)

- [x] Staging: Produkt-Import gegen Prod im Lesemodus (SKU-Match setzt
      `shopify_variant_id`), Bestellungen per 15-Minuten-Abgleich
      mitlesen und mit Odoo vergleichen. *Stand 2026-10-01: 267 Varianten
      verknüpft, 2.250 Kunden und 110 Bestellungen übernommen, Abgleich
      läuft (letzter 09:00 UTC).*
- [ ] Shop-Verfügbarkeit einstellen (Verkauf → Shop-Verfügbarkeit):
      Projekte/Farb-Pills, Schwellen je Teil (z. B. Blue Cases unter 2),
      zurückgehaltene Teile (Yellow Cases), Artikel aus (Black Week
      Editions), immer verfügbar (Switch-Tester); Made-to-Order-Puffer und
      -Deckel unter Einstellungen → Anbindungen. Im **Probelauf** in der
      Debug-Box gegenprüfen, was an Shopify ginge.
- [x] KRNL, vor dem Schreibmodus: Bestand auch an **Zweitangebote** melden
      (Bundle-Bestandteile mit derselben SKU, z. B. „Black Week Editions").
      Heute bekommt nur das verknüpfte Angebot den Bestand; die Bundles-App
      rechnet die Bundle-Verfügbarkeit aber aus den Bestandteilen.
      *Stand 2026-10-01: umgesetzt (Migration 0106,
      [module/integrationen.md](module/integrationen.md) „Zweitangebote") —
      jede Bestandsmeldung geht mit derselben Menge auch an alle
      Zweitangebote, im Probelauf als eigener Eintrag „Bestand an
      Zweitangebote" in der Debug-Box. Gefunden werden sie beim nächsten
      Reconcile (viertelstündlich) bzw. sofort mit „Shop-Stand holen". Je
      Angebot steuerbar unter Verkauf → Shop-Verfügbarkeit, Karte
      „Zweitangebote" — Betreiber: dort nach dem Deploy prüfen, dass die
      Black Week Editions als Zweitangebot (nicht als Artikel) erscheinen,
      und sie dort auf „aus" stellen, solange die Aktion nicht läuft.*
- [ ] Stichtag: Shopify-Modus von „Probelauf" auf **schreiben** stellen, dann Webhooks
      registrieren, einmal „Mit Shopify abgleichen" (Bestand), Order-
      Backfill nur ab Stichtag.

## 7. Probelauf und Stichtag

- [x] Nach dem Deploy einmal `/integrationen` → „Jetzt prüfen": alle
      konfigurierten Dienste grün; danach meldet der Wächter alle fünf
      Minuten nur noch Änderungen (Störung/Entstörung) an Telegram.
      *Stand 2026-10-01: alle konfigurierten Dienste grün; Mail und Google
      „unbekannt" (nicht eingerichtet).*

- [ ] Probelauf-Choreografie lokal mit **frischem** Odoo-Dump grün,
      inklusive No-Op-Beweis
      ([migration-odoo.md](migration-odoo.md#probelauf-choreografie-lokal-vor-jedem-prod-gedanken)).
- [ ] Stichtag nach dem [Cutover-Runbook](migration-odoo.md#cutover-runbook-stichtag):
      Odoo einfrieren → Dump → PITR-Punkt → Prod leerräumen → Import →
      Abnahme → Shopify → Betrieb.
- [ ] Nach dem Import: Einstellungen → Schnittstellen zeigt alle Anbindungen
      konfiguriert und erreichbar, der Ereignis-Monitor `/integrationen` ist ruhig,
      die Cron-Ergebnisse der ersten Stunde durchsehen (Outbox leer,
      Tracking ohne `fehler`).

## 7b. Einkaufstool (Betreiber, vor dem echten Postfach-Betrieb)

Stufen 1–3 sind in Prod (Ablage, Postfach, Mails, Projekte); ohne Google
laufen sie nicht an. Stufe 4 (Muster, Werkzeuge, Verträge) und Stufe 5
(Sendungen, Zoll, Pflichtdokumente, Cockpit, DATEV-Vorbereitung) brauchen
kein Google. Anleitung: [module/einkaufstool.md](module/einkaufstool.md).

- [ ] Google Workspace: Postfach `einkauf@…` anlegen und delegieren,
      Dienstkonto mit domänenweiter Delegation (nur `gmail.modify`, nur
      dieses Postfach), geteilte Ablage „Einkauf" mit dem Dienstkonto als
      Inhaltsmanager; in Vercel `GOOGLE_DIENSTKONTO_JSON`, `EINKAUF_POSTFACH`,
      `GOOGLE_EINKAUF_ABLAGE_ID`, dann Einstellungen → Anbindungen →
      „Ablage einrichten".
- [ ] Firmendaten: EORI und USt-IdNr. eintragen (Spediteur, Zoll).
- [ ] Lieferanten pflegen: Sprache, Maildomain(s), Einkäufer, Standard-
      Incoterm und -Währung — damit ordnet das Postfach selbst zu.
- [ ] Steuerberater: DATEV-Beleg-Mail klären (Upload-Adresse, Absender-
      Freigabe, ein Beleg je Mail, Größengrenze) — Voraussetzung für den
      Versand. **Stufe 5 hat DATEV nur vorbereitet** (Betreiber
      2026-10-01): `/einkauf/datev` zeigt, welche gebuchten Rechnungen mit
      Beleg bereitstünden; gesendet wird nichts. `DATEV_BELEG_MAIL` erst
      setzen, wenn der Versand gebaut ist (Entscheidungslog 2026-10-01).
- [ ] Spediteur (K+N) und Kuriere als Lieferanten anlegen (Mailadresse,
      Sprache) — sie sind Rechnungssteller der Sendungskosten und Empfänger
      der Nachfrage fehlender Fracht-/Zollbelege.
- [ ] Frachtsätze und Zolltarife prüfen (Einkauf → Einstand); nach den
      ersten abgerechneten Sendungen die Vorschläge übernehmen.
- [ ] Einkäufer an Bestellungen bzw. in der Lieferantenakte eintragen — das
      Cockpit und die tägliche Telegram-Zusammenfassung gliedern danach;
      `ERP_PUBLIC_URL` setzen, damit die Zusammenfassung verlinkt. Cron
      `/api/cron?task=einkauf` steht in `vercel.json`.

## 7c. Entscheidungen, die der Betreiber treffen muss

- [ ] Kundenrechnungen (Ausgangsrechnung, Zahlungseingang, Mahnwesen) aus
      KRNL — oder weiter aus Shopify? Erst danach baut KRNL sie.
- [ ] Stichtag festlegen; vorher einen frischen Odoo-Dump für den lokalen
      Probelauf bereitstellen.

## 8. Nachlauf

- [ ] Odoo auf lesend/Archiv, Kündigung erst nach Ablauf der
      Aufbewahrungsfrist für Belege klären.
- [ ] Sendcloud erst kündigen, wenn keine Sendcloud-Retourenlabels mehr
      im Umlauf sind (Kunden haben alte Labels noch Wochen später).
- [ ] Erinnerungen: DHL-Systembenutzer-Passwort (365 Tage), Shopify-
      Token-Erneuerung läuft automatisch, Supabase-Backups stichprobenartig
      wiederherstellen.
