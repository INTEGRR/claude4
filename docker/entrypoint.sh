#!/bin/sh
# Wartet auf die Datenbank, spielt Migrationen ein und legt beim ersten Start
# Administrator und (optional) Beispieldaten an.
set -e

ATTEMPTS=${DB_WAIT_ATTEMPTS:-60}   # 60 x 2 s = 2 Minuten
i=0

echo "→ Warte auf die Datenbank …"
until node --experimental-strip-types scripts/migrate.ts 2>/tmp/migrate.err; do
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

echo "→ ERP startet auf Port ${PORT:-3000}"
exec "$@"
