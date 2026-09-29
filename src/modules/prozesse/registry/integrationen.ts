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

  'integrationen.webhooks_registrieren': {
    label: 'Shopify-Webhooks registrieren',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt die Webhook-Abos (Bestellungen, Stornos, Bestände) im Shop an bzw. zieht sie auf die ' +
      'angegebene öffentliche Adresse um — danach kommen Änderungen sekundenschnell statt über ' +
      'den viertelstündlichen Abgleich. Im Lesemodus gesperrt (Shopify-Mutation).',
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
