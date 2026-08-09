#!/bin/sh
# Zeitsteuerung für den Docker-Betrieb.
#
# Auf Vercel übernimmt das die Plattform (vercel.json). Lokal gibt es keinen
# Scheduler — ohne diesen Dienst läuft die Outbox nie: Fulfillment würde nicht
# an Shopify gemeldet, Bestell-Mails blieben liegen, die Sendungsverfolgung
# stünde still und die Kennzahlen zeigten Zahlen von vorgestern.
#
# Die Staffelung entspricht vercel.json. Der Zähler zählt Minuten.
set -eu

ZIEL=${ERP_URL:-http://app:3000}
i=0

ruf() {
  if [ -n "${CRON_SECRET:-}" ]; then
    wget -qO- --header="Authorization: Bearer ${CRON_SECRET}" "${ZIEL}/api/cron?task=$1" >/dev/null 2>&1 ||
      echo "  cron: $1 fehlgeschlagen"
  else
    wget -qO- "${ZIEL}/api/cron?task=$1" >/dev/null 2>&1 || echo "  cron: $1 fehlgeschlagen"
  fi
}

# Auf die Anwendung warten, sonst laufen die ersten Aufrufe ins Leere.
until wget -qO- "${ZIEL}/login" >/dev/null 2>&1; do sleep 3; done
echo "→ Zeitsteuerung aktiv (Ziel ${ZIEL})"

# Bewusst ausgeschrieben statt „[ … ] && ruf …": mit `set -e` beendet ein
# fehlschlagender Test als letztes Glied einer &&-Kette die ganze Schleife —
# die Zeitsteuerung wäre nach der ersten Minute still.
while true; do
  ruf jobs
  ruf webhooks
  if [ $((i % 15)) -eq 0 ]; then ruf reconcile; fi
  if [ $((i % 60)) -eq 0 ]; then ruf tracking; fi
  if [ $((i % 360)) -eq 0 ]; then ruf analytics; fi
  if [ $((i % 1440)) -eq 0 ]; then ruf housekeeping; fi
  i=$((i + 1))
  sleep 60
done
