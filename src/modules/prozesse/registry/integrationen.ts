import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Integrations-Aktionen: die Klärliste. Unbekannte Shop-SKUs landen als
 * ungeklärte Zeilen (shopify_unmatched_lines) — das Auflösen ist genau die
 * Aktion, die der matching-Schritttyp der Prozesse referenzieren wird.
 */
export const INTEGRATIONEN = {
  'integrationen.klaerfall_aufloesen': {
    label: 'Klärfall auflösen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Ordnet eine unbekannte Shop-SKU einer Variante zu. Die Zuordnung wird dauerhaft an der ' +
      'Variante gespeichert (Shop-Varianten-ID, fehlende SKU), damit der nächste Import passt.',
    bindung: 'beleg',
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte eine Variante auswählen'),
    }),
    formdata: (fd) => ({ variant_id: String(fd.get('variant_id') ?? '') }),
    revalidate: ['/integrationen'],
  },

  'integrationen.klaerfaelle_aufloesen': {
    label: 'Klärfälle eines Shop-Artikels auflösen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Ordnet ALLE offenen Klärfälle eines Shop-Artikels (gleiche Shop-Variante, sonst gleiche SKU und ' +
      'gleicher Titel) in einem Schritt einer Variante zu, speichert die Zuordnung an der Variante und ' +
      'reiht je betroffener Bestellung das Nachziehen ein (Job shopify_bestellung_nachziehen): die Position ' +
      'kommt in den Auftrag, bezahlte Aufträge werden bestätigt. Für viele Bestellungen mit demselben ' +
      'unbekannten Artikel — statt Zeile für Zeile.',
    bindung: 'frei',
    schema: z.object({
      variant_id: z.string().guid('Bitte eine Variante auswählen'),
      variant_gid: z.string().max(200).nullable().optional(),
      sku: z.string().max(200).nullable().optional(),
      titel: z.string().max(500).nullable().optional(),
    }),
    zusammenfassung: (p) => `Klärfälle zu „${p.titel ?? p.sku ?? p.variant_gid ?? 'Shop-Artikel'}" zuordnen`,
    formdata: (fd) => {
      const text = (k: string) => {
        const v = String(fd.get(k) ?? '').trim()
        return v === '' ? null : v
      }
      return {
        variant_id: String(fd.get('variant_id') ?? ''),
        variant_gid: text('variant_gid'),
        sku: text('sku'),
        titel: text('titel'),
      }
    },
    revalidate: ['/integrationen'],
  },

  'integrationen.webhooks_registrieren': {
    label: 'Shopify-Webhooks registrieren',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt die Webhook-Abos (Bestellungen, Stornos, Bestände) im Shop an bzw. zieht sie auf die ' +
      'angegebene öffentliche Adresse um — danach kommen Änderungen sekundenschnell statt über ' +
      'den viertelstündlichen Abgleich. Im Modus „nur lesen" gesperrt; im Probelauf erlaubt (ändert im Shop nichts).',
    bindung: 'frei',
    schema: z.object({
      url: z
        .string()
        .trim()
        .url('Bitte die öffentliche Adresse des ERP angeben')
        .regex(/^https:\/\//, 'Die Adresse muss mit https:// beginnen — auf localhost kann Shopify nicht zustellen'),
    }),
    zusammenfassung: (p) => `Webhooks → ${p.url}`,
    formdata: (fd) => ({ url: String(fd.get('url') ?? '') }),
    revalidate: ['/einstellungen/anbindungen', '/integrationen'],
  },
  // --- Shopify-Historie und Netto-Preise (0089) -----------------------------

  'integrationen.historie_pruefen': {
    label: 'Shopify-Historie prüfen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Vorschau des CSV-Historie-Imports: welche SKUs des Exports KRNL nicht kennt (sie werden ' +
      'als archivierte Historie-Artikel angelegt) und wie viele Bestellungen schon da sind. ' +
      'Schreibt nichts.',
    bindung: 'frei',
    schema: z.object({
      skus: z.array(z.string().max(200)).max(50_000),
      namen: z.array(z.string().max(100)).max(200_000),
    }),
    zusammenfassung: (p) => `${p.namen.length} Bestellungen, ${p.skus.length} SKUs geprüft`,
    revalidate: [],
  },

  'integrationen.historie_importieren': {
    label: 'Shopify-Historie übernehmen (Paket)',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Übernimmt ein Paket Bestellungen aus dem Shopify-CSV-Export als historische Aufträge — ' +
      'Netto-Preise, ohne Lieferung, Reservierung oder Fertigung. Bereits vorhandene ' +
      '(Shopify-ID oder Bestellname) werden übersprungen; offene Bestellungen der letzten 60 ' +
      'Tage bleiben dem Live-Import.',
    bindung: 'frei',
    schema: z.object({
      bestellungen: z
        .array(
          z.object({
            id: z.string().regex(/^\d+$/).nullable(),
            name: z.string().min(1).max(100),
            datum: z.string().min(10).max(40),
            email: z.string().max(300).nullable(),
            kunde: z.string().min(1).max(300),
            land: z.string().length(2).nullable(),
            status: z.enum(['erfuellt', 'storniert', 'offen']),
            waehrung: z.string().min(3).max(3),
            steuersatz: z.number().min(0).max(100),
            versandNetto: z.number().min(0),
            positionen: z
              .array(
                z.object({
                  sku: z.string().max(200).nullable(),
                  name: z.string().min(1).max(500),
                  menge: z.number().positive(),
                  stueckNetto: z.number(),
                }),
              )
              .max(500),
          }),
        )
        .min(1)
        .max(250),
    }),
    zusammenfassung: (p) => `${p.bestellungen.length} Bestellungen (${p.bestellungen[0]?.name} …)`,
    revalidate: ['/verkauf', '/auswertungen', '/integrationen/historie'],
  },

  'integrationen.shopify_preise_nachziehen': {
    label: 'Shopify-Preise netto nachziehen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Holt bereits importierte Shopify-Aufträge frisch aus dem Shop (lesend) und setzt ihre ' +
      'Positionen auf Netto-Preise nach Rabatt samt Steuersatz, dazu die Versandkosten. Bis ' +
      'Migration 0089 stand dort der Brutto-Listenpreis. Je Lauf bis zu 30 Aufträge.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/verkauf', '/auswertungen', '/integrationen'],
  },

  'integrationen.versand_abgleichen': {
    label: 'Versand offener Shop-Aufträge prüfen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Holt jeden Shop-Auftrag mit offener Lieferung und ohne eigene Sendung frisch aus dem Shop (lesend). ' +
      'Hat der Shop ihn inzwischen versendet (Sendcloud), bucht KRNL den Warenausgang nach und legt bei ' +
      'offenem Fertigungsauftrag die Nachfrage ans Team Fertigung an. Der Abgleich-Cron macht dasselbe ' +
      'reihum mit zehn je Lauf — hier alle auf einmal (bis 200).',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/integrationen', '/verkauf', '/fertigung', '/aufgaben'],
  },

  // --- Odoo-Stücklisten (0090) ------------------------------------------------

  'integrationen.odoo_vorschau': {
    label: 'Odoo-Übernahme: Vorschau',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Liest Stücklisten, Komponenten, Lieferanten und Bestände aus Odoo und zeigt, was die ' +
      'Übernahme täte: zugeordnet per SKU, neu anzulegen, blockiert mit Grund. Schreibt nichts.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: [],
  },

  'integrationen.odoo_stuecklisten_uebernehmen': {
    label: 'Odoo-Stücklisten übernehmen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Übernimmt aus Odoo die Stücklisten an die per SKU zugeordneten Tastaturen und Switch-Tester, ' +
      'legt fehlende Komponenten an, setzt Einkaufspreis und Bestand nur, wo KRNL 0 hat, ' +
      'übernimmt Lieferantenpreise und die Routen Fertigen/Auf Auftrag. Eine Transaktion; ' +
      'ein zweiter Lauf legt nichts doppelt an. Kunden und Belege nicht.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/einstellungen/odoo', '/fertigung/stuecklisten', '/produkte'],
  },

  'integrationen.odoo_fertigbestand_zuruecknehmen': {
    label: 'Odoo-Fertigbestand zurücknehmen, Fertigung nachziehen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Setzt den Bestand der Fertigprodukte (Artikel mit Odoo-Stückliste, keine Komponente) auf 0, ' +
      'wenn er nur aus Inventurbuchungen stammt — der Odoo-Bestand war falsch, weil Lieferungen in Odoo ' +
      'nicht ausgebucht wurden. Löst vorher Reservierungen wartender Lieferungen; bucht per Inventur ' +
      '(bewertet, nachvollziehbar). Artikel mit echten Lagerbewegungen bleiben und werden gemeldet. ' +
      'Danach bekommt jeder offene Verkaufsauftrag (Route Fertigen + Auf Auftrag) für die noch nicht ' +
      'gefertigte Menge einen bestätigten Fertigungsauftrag.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/einstellungen/odoo', '/lager', '/produkte', '/versand', '/fertigung', '/verkauf'],
  },

  'integrationen.odoo_artikel_zusammenfuehren': {
    label: 'Doppelten Artikel zusammenführen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Führt eine von der Odoo-Übernahme angelegte Komponente in den Shop-Artikel zusammen, der dasselbe ' +
      'Einzelteil ist: Bestand (per Inventur), Stücklistenzeilen, offene Bewegungen, Lieferantenpreise, ' +
      'Meldebestand und Odoo-Zuordnung wandern mit, die SKU wird SKU bzw. Barcode des Shop-Artikels, die ' +
      'Odoo-Kopie wird archiviert. Nur ohne Belege und ohne fremde Lagerbuchungen.',
    bindung: 'frei',
    schema: z.object({
      aufloesen_id: z.string().guid(),
      behalten_id: z.string({ error: 'Bitte einen Shop-Artikel wählen' }).guid('Bitte einen Shop-Artikel wählen'),
    }),
    formdata: (fd) => ({
      aufloesen_id: String(fd.get('aufloesen_id') ?? ''),
      behalten_id: String(fd.get('behalten_id') ?? ''),
    }),
    revalidate: ['/einstellungen/odoo', '/lager', '/produkte', '/fertigung'],
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
