/**
 * Katalog der Outbox-Jobs — die asynchronen Prozessschritte („dienst").
 *
 * Die Handler selbst leben unverändert in src/modules/integrationen/jobs.ts;
 * hier stehen ihre Metadaten, damit Prozesse, Repository-Seite und Tests sie
 * adressieren können. `faehigkeit` benennt, WAS der Schritt leistet, nicht
 * WER es tut — Prozesse referenzieren die Fähigkeit, damit ein späterer
 * Anbieterwechsel (anderer Shop, anderer Paketdienst) die Prozessdefinitionen
 * nicht anfasst.
 */

export interface JobEintrag {
  label: string
  beschreibung: string
  /** Anbieterneutraler Zweck, z. B. 'shop:fulfillment_melden'. */
  faehigkeit: string
  /**
   * Eigene Spur (0109): Jobs der Spur „ki" laufen nur im Cron
   * `/api/cron?task=ki`, nie im allgemeinen Lauf — ein Agentenlauf von 30 s
   * hält weder Shopify-Meldungen noch Mail-Versand auf.
   */
  spur?: 'ki'
}

export const JOB_KATALOG = {
  shopify_fulfillment_create: {
    label: 'Fulfillment an den Shop melden',
    beschreibung: 'Meldet die Sendung mit Trackingnummer; der Shop verschickt die Kundenmail.',
    faehigkeit: 'shop:fulfillment_melden',
  },
  shopify_tag_add: {
    label: 'Shop-Tag setzen',
    beschreibung: 'Hängt einen Status-Tag an die Shop-Bestellung (optional, Default aus).',
    faehigkeit: 'shop:tag_setzen',
  },
  shopify_order_cancel: {
    label: 'Storno an den Shop melden',
    beschreibung:
      'Storniert die Shop-Bestellung nach einem ERP-Storno (Bestand zurück ins Shop-Inventar); ' +
      'die Rückerstattung bleibt ein manueller Schritt im Shop.',
    faehigkeit: 'shop:bestellung_stornieren',
  },
  shopify_inventory_push: {
    label: 'Bestand an den Shop melden',
    beschreibung: 'Überträgt geänderte verfügbare Mengen (Dedupe „inventar-abgleich").',
    faehigkeit: 'shop:bestand_melden',
  },
  shopify_customer_import: {
    label: 'Kunden aus dem Shop übernehmen',
    beschreibung: 'Erstübernahme aller Shop-Kunden in Häppchen (Cursor im Dedupe-Schlüssel).',
    faehigkeit: 'shop:kunden_import',
  },
  shopify_product_push: {
    label: 'Produkt in den Shop übertragen',
    beschreibung: 'Legt ein ERP-Produkt samt Varianten im Shop an bzw. gleicht Änderungen ab.',
    faehigkeit: 'shop:produkt_uebertragen',
  },
  shopify_product_import: {
    label: 'Produkte aus dem Shop übernehmen',
    beschreibung: 'Erstübernahme des Shop-Katalogs (verknüpfen per SKU/Barcode, sonst anlegen).',
    faehigkeit: 'shop:produkt_import',
  },
  shopify_order_backfill: {
    label: 'Bestellungen aus dem Shop übernehmen',
    beschreibung: 'Holt historische Bestellungen zur Abfrage q in Häppchen.',
    faehigkeit: 'shop:bestellungen_import',
  },
  daten_tuev: {
    label: 'Daten-TÜV (Invarianten-Check)',
    beschreibung:
      'Prüft nachts die Kern-Ledger (Bestand = Moves, Bewertung schlüssig, Reservierungen); ' +
      'Befunde schlagen absichtlich als Fehler auf.',
    faehigkeit: 'daten:integritaet_pruefen',
  },
  send_po_email: {
    label: 'Bestellung mailen',
    beschreibung: 'Schickt die Einkaufsbestellung als PDF an den Lieferanten.',
    faehigkeit: 'mail:bestellung',
  },
  send_return_label_email: {
    label: 'Retourenlabel mailen',
    beschreibung: 'Schickt das DHL-Retourenlabel samt QR-Code an den Kunden.',
    faehigkeit: 'mail:retourenlabel',
  },
  send_repair_request_email: {
    label: 'Reparaturanfrage bestätigen (Kunde)',
    beschreibung:
      'Eingangsbestätigung mit Vorgangsnummer an den Kunden, der über das öffentliche Formular ' +
      'eine Reparatur angefragt hat.',
    faehigkeit: 'mail:anfrage_bestaetigung',
  },
  gmail_anhang_ablegen: {
    label: 'Mail-Anhang ablegen',
    beschreibung:
      'Legt einen Anhang aus dem Einkaufspostfach in der Drive-Ablage ab (Ordner von Bestellung ' +
      'bzw. Lieferant, sonst Eingang) und verknüpft ihn mit Thread, Lieferant und Bestellung; ' +
      'gleicher Inhalt beim selben Lieferanten wird verknüpft statt kopiert.',
    faehigkeit: 'ablage:mailanhang_ablegen',
  },
  gmail_senden: {
    label: 'Mail an Lieferanten senden',
    beschreibung:
      'Sendet einen freigegebenen Entwurf über das Einkaufspostfach im bestehenden Thread ' +
      '(In-Reply-To/References), Anhänge aus der Ablage; legt die Nachricht im Thread ab und ' +
      'bei „Antwort erwartet bis" die Wiedervorlage.',
    faehigkeit: 'mail:lieferant_senden',
  },
  mail_uebersetzen: {
    label: 'Lieferanten-Mail übersetzen',
    beschreibung: 'Übersetzt eine eingegangene (z. B. chinesische) Nachricht per KI ins Deutsche.',
    faehigkeit: 'ki:uebersetzen',
  },
  ezb_kurse_abrufen: {
    label: 'EZB-Kurse abrufen',
    beschreibung:
      'Holt werktags die Referenzkurse der EZB und speichert sie als EUR je Fremdeinheit (Quelle „ezb"); ' +
      'von Hand erfasste Kurse bleiben stehen. Grundlage des Angebotsvergleichs in EUR.',
    faehigkeit: 'finanzen:wechselkurse',
  },
  einkauf_digest: {
    label: 'Einkaufs-Zusammenfassung',
    beschreibung:
      'Reiht morgens die Zusammenfassung des Einkaufs-Cockpits je Einkäufer in den Telegram-Kanal ein (Überfälliges, ' +
      'heute Fälliges, fehlende Dokumente und Rechnungen, fällige Raten, überfällige ETA); nichts offen → keine Nachricht.',
    faehigkeit: 'einkauf:zusammenfassung',
  },
  ki_mail_triage: {
    label: 'Eingehende Mail sichten (KI)',
    beschreibung:
      'Der Einkaufs-Agent sichtet eine eingehende Lieferanten-Nachricht und legt NUR Vorschläge (Zuordnung, Angebot, ' +
      'Wiedervorlage, Entscheidungsvorlage) und einen Antwort-Entwurf an — gesendet und entschieden wird von Menschen. ' +
      'Ohne eingeschaltete KI-Ebene „Einkauf" oder ohne Schlüssel übersprungen.',
    faehigkeit: 'ki:mail_sichten',
    spur: 'ki',
  },
  ki_dokument_lesen: {
    label: 'Dokument lesen (KI)',
    beschreibung:
      'Gibt ein PDF oder Bild aus der Ablage an die KI, speichert den Text am Dokument (durchsuchbar) und schlägt bei ' +
      'einem Angebot „Angebot erfassen" vor. Excel ist ohne Parser nicht lesbar.',
    faehigkeit: 'ki:dokument_lesen',
    spur: 'ki',
  },
} satisfies Record<string, JobEintrag>

export type JobKind = keyof typeof JOB_KATALOG

/** Die Jobs der KI-Spur (eigener Cron, eigenes Zeitbudget). */
export const KI_SPUR_JOBS: string[] = Object.entries(JOB_KATALOG as Record<string, JobEintrag>)
  .filter(([, j]) => j.spur === 'ki')
  .map(([kind]) => kind)
