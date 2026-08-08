# Betrieb & Deployment

## Ausgangslage

Das ERP enthält Auftrags-, Kunden- und Lieferantendaten. Die Oberfläche soll
nicht öffentlich erreichbar sein. Gleichzeitig braucht das System Kontakt nach
außen: Shopify (Bestellungen), DHL (Labels, Tracking) und den Mailversand.

Wichtig für die Architekturentscheidung: **alle Aufrufe zu Shopify, DHL und
Resend gehen ausgehend** — nur der Shopify-Webhook wäre ein eingehender Aufruf.
Und genau den braucht das System nicht zwingend, weil der Abgleich-Job
(`/api/cron?task=reconcile`) Bestellungen aktiv bei Shopify abholt.

Daraus ergeben sich zwei tragfähige Varianten.

---

## Variante A: vollständig hinter VPN (empfohlen)

Kein einziger öffentlich erreichbarer Endpunkt. Bestellungen kommen über
aktives Abholen statt über Webhooks herein.

```
   Team ──[WireGuard/Tailscale]──▶ ERP (privates Netz)
                                     │  ausgehend über NAT-Gateway
                                     ├──▶ Shopify Admin API   (Orders abholen, Fulfillment melden)
                                     ├──▶ DHL Parcel DE API   (Label, Tracking, Retouren)
                                     └──▶ Resend              (E-Mail)
```

**Umsetzung**
- Server: eigener Host (z. B. Hetzner Cloud) oder VPC-interner Dienst; nur
  über das VPN erreichbar, keine öffentliche Eingangsregel außer SSH über VPN.
- Datenbank: verwaltetes Postgres im selben privaten Netz. Bei Supabase: die
  Verbindung geht ausgehend, das ist unkritisch — alternativ Postgres selbst
  betreiben, dann bleibt alles im eigenen Netz.
- VPN: **Tailscale** ist hier der geringste Aufwand (kein eigener VPN-Server,
  Geräte-Autorisierung, MFA über den bestehenden Identity-Provider).
- Zeitsteuerung: systemd-Timer oder Cron auf dem Host rufen die
  `/api/cron?task=…`-Endpunkte lokal auf (`127.0.0.1`) — kein Vercel Cron nötig.
- **Shopify-Webhooks werden nicht eingerichtet.** Stattdessen läuft
  `task=reconcile` häufiger, z. B. jede Minute statt alle 15 Minuten.

**Konsequenz:** Bestellungen erscheinen mit bis zu einer Minute Verzögerung
statt in Sekunden. Für den Ablauf (Fertigung, Versand) ist das ohne Bedeutung.
Mehr API-Aufrufe bei Shopify, aber weit innerhalb der Grenzen.

**Was dafür anzupassen ist:** nichts am Code. Nur die Cron-Frequenz erhöhen und
`SHOPIFY_WEBHOOK_SECRET` weglassen — der Webhook-Endpunkt weist ohne Secret
ohnehin alles ab.

---

## Variante B: gehostet mit geschützter Oberfläche

Wenn der Komfort einer verwalteten Plattform (Vercel) gewünscht ist:

- **Oberfläche** hinter Zugangsschutz: Vercel Deployment Protection (SSO) oder
  Cloudflare Access davor. Ohne gültige Sitzung kommt niemand an die App.
- **Nur zwei Pfade öffentlich freigeben:**
  - `/api/webhooks/shopify` — durch HMAC-Signaturprüfung geschützt, ohne
    gültige Signatur gibt es 401. Kein Datenabfluss möglich, der Endpunkt
    speichert nur.
  - `/api/cron/*` — abgesichert über `CRON_SECRET` im Authorization-Header.
- Datenbank bleibt privat (Supabase mit eingeschränkten Netzwerkregeln).

**Konsequenz:** Bestellungen kommen in Sekunden an. Dafür existieren zwei
öffentlich erreichbare Endpunkte, die man im Blick behalten muss.

Schritt für Schritt durchgespielt: [vercel-supabase.md](vercel-supabase.md).

---

## Empfehlung

**Variante A**, wenn „nicht öffentlich erreichbar" das Ziel ist — sie erfüllt
das ohne Ausnahmen, und die eine Minute Verzögerung beim Bestellimport fällt im
Tagesgeschäft nicht auf. Der Reconciliation-Job war ohnehin als Sicherheitsnetz
gegen verlorene Webhooks gebaut; hier wird er einfach zum Hauptweg.

**Variante B**, wenn Bestellungen möglichst sofort sichtbar sein sollen oder
kein eigener Server betrieben werden soll.

Beide Varianten laufen mit derselben Codebasis — die Entscheidung lässt sich
später ohne Umbau ändern.

---

## Lokal ausprobieren

Ausführlich in [lokal-starten.md](lokal-starten.md). Kurzfassung:

```bash
docker compose up --build     # → http://localhost:3000
```

Startet Postgres und das ERP, spielt Migrationen ein und legt Administrator
und Beispieldaten an. Shopify und DHL bleiben ohne Zugangsdaten deaktiviert —
alle übrigen Module laufen vollständig. `docker compose down -v` verwirft alles
wieder.

Der Datenbank-Port wird bewusst **nicht** nach außen veröffentlicht (die App
erreicht die Datenbank über das Compose-Netz). Wer mit `psql` hineinschauen
möchte, entfernt in `docker-compose.yml` die Kommentarzeichen beim `ports`-Block
des `db`-Dienstes.

## Betriebsaufgaben (unabhängig von der Variante)

| Aufgabe | Frequenz | Aufruf |
|---|---|---|
| Shopify-Webhooks verarbeiten | minütlich (nur Variante B) | `/api/cron?task=webhooks` |
| Outbox abarbeiten (Fulfillment, E-Mail) | minütlich | `/api/cron?task=jobs` |
| Bestellabgleich mit Shopify | Variante A: minütlich · B: alle 15 Min | `/api/cron?task=reconcile` |
| DHL-Sendungsverfolgung | stündlich | `/api/cron?task=tracking` |
| Aufräumen (Sitzungen, Trackingdaten) | täglich | `/api/cron?task=housekeeping` |

Weitere Punkte:
- **Label-Dateien** liegen unter `STORAGE_DIR` (Standard: `./storage`). Bei
  mehreren Instanzen ein gemeinsames Volume mounten oder auf Objektspeicher
  umstellen — DHL hält Labels nur rund drei Tage vor.
- **Datenbank-Backups** einschalten (Supabase: PITR).
- **DHL-Systembenutzer:** Passwort läuft nach 365 Tagen ab — Erinnerung setzen.
- **DHL-Tracking-Limit:** Standard sind 250 Abfragen pro Tag. Für den
  Produktivbetrieb frühzeitig eine Erhöhung beantragen.
- **Shopify-Zugriff:** Orders älter als 60 Tage brauchen den zusätzlichen Scope
  `read_all_orders`.
