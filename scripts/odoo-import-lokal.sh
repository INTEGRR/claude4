#!/usr/bin/env bash
# Odoo-Übernahme vom eigenen Rechner aus fahren (docs/migration-odoo.md).
#
# Hintergrund: Claude-Cloud-Umgebungen lassen keine rohen Postgres-
# Verbindungen nach außen zu — der Lauf gegen Supabase braucht deshalb
# einen Rechner mit normalem Netzzugang. Dieses Skript verlangt nur
# Docker; Node und Postgres kommen aus Containern.
#
# Aufruf (aus dem Repo-Wurzelverzeichnis, unter Windows in der Git Bash):
#   scripts/odoo-import-lokal.sh <dump.zip|dump.sql> "<DIRECT_URL>" [odoo:import-Argumente]
#
# Beispiele:
#   scripts/odoo-import-lokal.sh ~/Downloads/dump.zip "postgres://postgres.<ref>:<pw>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" --dry-run
#   scripts/odoo-import-lokal.sh ~/Downloads/dump.zip "postgres://…" --lauf=prod-1
#
# Die DIRECT_URL ist die Session-Pooler-URI aus dem Supabase-Dashboard
# (Connect → Session pooler, Port 5432 — NICHT der Transaction-Pooler 6543).
# Wiederholte Läufe nutzen die bereits geladene Staging-DB; ein frischer
# Dump wird mit `docker rm -f krnl-odoo-quelle` erzwungen.
set -euo pipefail

# Git Bash unter Windows wandelt Argumente mit führendem „/" in
# Windows-Pfade um und zerstört damit z. B. „-w /app" — abschalten
# (auf Mac/Linux wirkungslos).
export MSYS_NO_PATHCONV=1

DUMP="${1:?Pfad zum Odoo-Dump (dump.zip oder dump.sql) fehlt}"
ZIEL_URL="${2:?DIRECT_URL zur Ziel-Datenbank fehlt (Supabase Session-Pooler, Port 5432)}"
shift 2

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NETZ=krnl-import
QUELLE=krnl-odoo-quelle

docker network inspect "$NETZ" >/dev/null 2>&1 || docker network create "$NETZ" >/dev/null

if ! docker ps --format '{{.Names}}' | grep -qx "$QUELLE"; then
  docker rm -f "$QUELLE" >/dev/null 2>&1 || true
  echo "→ Staging-Postgres starten …"
  docker run -d --name "$QUELLE" --network "$NETZ" \
    -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=odoo_quelle \
    postgres:16 >/dev/null
fi

echo "→ warten, bis die Staging-DB bereit ist …"
for _ in $(seq 1 60); do
  if docker exec "$QUELLE" pg_isready -U erp -d odoo_quelle -q 2>/dev/null; then break; fi
  sleep 1
done

if ! docker exec "$QUELLE" psql -U erp -d odoo_quelle -tAc \
    "select 1 from information_schema.tables where table_name = 'sale_order'" | grep -q 1; then
  SQL="$DUMP"
  case "$DUMP" in
    *.zip)
      command -v unzip >/dev/null || {
        echo "unzip fehlt — bitte das Zip von Hand entpacken und die .sql-Datei übergeben."
        exit 1
      }
      echo "→ Dump entpacken …"
      ARBEIT="$(mktemp -d)"
      unzip -o -q "$DUMP" -d "$ARBEIT"
      SQL="$(find "$ARBEIT" -name '*.sql' | head -1)"
      [ -n "$SQL" ] || { echo "Kein .sql im Zip gefunden."; exit 1; }
      ;;
  esac
  echo "→ Dump in die Staging-DB laden (dauert 1–2 Minuten) …"
  docker exec -i "$QUELLE" psql -U erp -d odoo_quelle -q -v ON_ERROR_STOP=0 \
    < "$SQL" >/dev/null 2>&1 || true
  ANZ="$(docker exec "$QUELLE" psql -U erp -d odoo_quelle -tAc 'select count(*) from sale_order')"
  echo "   Staging geladen: $ANZ Verkaufsaufträge."
else
  echo "→ Staging-DB ist bereits geladen (frischer Dump: docker rm -f $QUELLE)."
fi

echo "→ Migrationen, Grunddaten und Import gegen das Ziel fahren …"
docker run --rm --network "$NETZ" -v "$REPO:/app" -w /app \
  -e ODOO_QUELLE_URL="postgres://erp:erp@$QUELLE:5432/odoo_quelle" \
  -e DIRECT_URL="$ZIEL_URL" \
  node:22 bash -c "npm ci --no-audit --no-fund && npm run db:migrate && npm run db:seed && npm run odoo:import -- $*"
