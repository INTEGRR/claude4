#!/bin/sh
# Wartet auf die Datenbank, spielt Migrationen ein und legt beim ersten Start
# Administrator und (optional) Beispieldaten an.
set -e

ATTEMPTS=${DB_WAIT_ATTEMPTS:-60}   # 60 x 2 s = 2 Minuten
i=0

echo "→ Warte auf die Datenbank …"
until node --experimental-strip-types scripts/migrate.ts 2>/tmp/migrate.err; do
  # Nur auf eine noch nicht erreichbare Datenbank wird gewartet. Ein echter
  # Migrationsfehler bricht sofort ab — sonst sähe er zwei Minuten lang wie
  # "Datenbank nicht bereit" aus und die eigentliche Meldung ginge unter.
  if ! grep -qE 'ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|starting up|Connection terminated' /tmp/migrate.err; then
    echo "✗ Migration fehlgeschlagen:"
    cat /tmp/migrate.err
    exit 1
  fi

  i=$((i + 1))
  if [ "$i" -ge "$ATTEMPTS" ]; then
    echo "✗ Datenbank nach $((ATTEMPTS * 2)) Sekunden nicht erreichbar:"
    cat /tmp/migrate.err
    exit 1
  fi
  # Alle 10 Versuche ein Lebenszeichen, damit man den Fortschritt sieht.
  if [ $((i % 10)) -eq 0 ]; then
    echo "  … noch nicht bereit (Versuch $i/$ATTEMPTS): $(tail -1 /tmp/migrate.err)"
  fi
  sleep 2
done

if [ "${SEED_DEMO}" = "true" ]; then
  node --experimental-strip-types scripts/seed.ts --demo
else
  node --experimental-strip-types scripts/seed.ts
fi

# Kurzer Konfigurationsbericht. Kostet nichts und beantwortet die Frage, die
# sonst eine Runde Rätselraten auslöst: "Warum ist die KI/Shopify/DHL aus?"
# Es werden nur "gesetzt"/"nicht gesetzt" ausgegeben, nie die Werte selbst.
melde() {
  if [ -n "$2" ]; then
    echo "   $1: gesetzt"
  else
    echo "   $1: nicht gesetzt — $3"
  fi
}

echo "→ Konfiguration:"
melde "KI-Analyse (ANTHROPIC_API_KEY)" "${ANTHROPIC_API_KEY}" "Seite /ki bleibt deaktiviert"
melde "Shopify (Client ID/Secret oder Admin-Token)" "${SHOPIFY_CLIENT_ID}${SHOPIFY_ADMIN_TOKEN}" "kein Bestellimport, kein Fulfillment"
melde "DHL (DHL_API_KEY)"              "${DHL_API_KEY}"          "keine Labels, kein Tracking"
melde "E-Mail (RESEND_API_KEY)"        "${RESEND_API_KEY}"       "keine Bestell-Mails"
if [ -z "${ANTHROPIC_API_KEY}${SHOPIFY_CLIENT_ID}${SHOPIFY_ADMIN_TOKEN}${DHL_API_KEY}${RESEND_API_KEY}" ]; then
  echo "   Hinweis: keine einzige Zugangsdatei erkannt. Liegt im Projektordner"
  echo "   wirklich eine Datei namens .env? Unter Windows blendet der Explorer"
  echo "   Endungen aus — aus .env.example wird beim Umbenennen leicht .env.txt."
  echo "   Prüfen mit:  docker compose config"
fi

echo "→ ERP startet auf Port ${PORT:-3000}"
exec "$@"
