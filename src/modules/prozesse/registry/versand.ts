import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Versands. Kern für den Shopify-Prozess (P4) ist
 * `versand.label_erstellen` — Massendruck, Storno, Tracking und Retouren
 * sind Werkzeuge außerhalb des Prozessflusses (prozessfrei).
 */
export const VERSAND = {
  'versand.label_erstellen': {
    label: 'DHL-Label erstellen',
    bereich: 'versand',
    beschreibung:
      'Erstellt das Versandlabel für eine Lieferung — Produkt und Versicherung nach den ' +
      'Versandregeln (überschreibbar), Zolldaten bei Drittland automatisch.',
    bindung: 'beleg',
    modell: 'stock_picking',
    schema: z.object({
      weight_g: z.number().positive().optional().describe('Gewicht überschreiben (Gramm)'),
      dhl_product: z.string().max(20).optional().describe('DHL-Produkt überschreiben'),
    }),
    formdata: (fd) => ({
      weight_g: fd.get('weight_g') ? Number(fd.get('weight_g')) : undefined,
      dhl_product: String(fd.get('dhl_product') ?? '') || undefined,
    }),
    revalidate: ['/versand', '/lager/:id'],
  },

  'versand.packtisch_abschliessen': {
    label: 'Packtisch: Sendung abschließen',
    bereich: 'versand',
    beschreibung:
      'Schließt eine gepackte Lieferung in einem Zug ab: prüft die gescannten Positionen ' +
      'gegen die Sollmengen (Schlüssel = SKU oder Artikel-Barcode), erstellt das DHL-Label ' +
      '(bzw. verwendet ein vorhandenes wieder), bucht den Warenausgang, verbraucht die ' +
      'Kartonage und reiht die Shop-Rückmeldung mit Tracking ein — Shopify benachrichtigt ' +
      'den Kunden.',
    bindung: 'beleg',
    modell: 'stock_picking',
    uebergang: { von: ['assigned'], nach: ['done'] },
    schema: z.object({
      gepackt: z
        .record(z.string(), z.number().nonnegative())
        .default({})
        .describe('Gescannte Mengen je SKU/Barcode'),
      weight_g: z.number().positive().optional().describe('Gewicht überschreiben (Gramm)'),
      dhl_product: z.string().max(20).optional().describe('DHL-Produkt überschreiben'),
    }),
    formdata: (fd) => {
      const gepackt: Record<string, number> = {}
      for (const [key, wert] of fd.entries()) {
        if (!key.startsWith('gepackt_')) continue
        const menge = Number(wert)
        if (Number.isFinite(menge)) gepackt[key.slice('gepackt_'.length)] = menge
      }
      return {
        gepackt,
        weight_g: fd.get('weight_g') ? Number(fd.get('weight_g')) : undefined,
        dhl_product: String(fd.get('dhl_product') ?? '') || undefined,
      }
    },
    revalidate: ['/versand', '/packtisch', '/lager/:id'],
  },

  'versand.label_stornieren': {
    label: 'Label stornieren',
    bereich: 'versand',
    beschreibung:
      'Storniert eine Sendung bei DHL (bis zum Tagesabschluss) und entfernt sie aus der Liste.',
    bindung: 'beleg',
    modell: 'shipment',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/versand'],
  },

  'versand.tracking_aktualisieren': {
    label: 'Tracking aktualisieren',
    bereich: 'versand',
    ki: true,
    beschreibung: 'Fragt den Sendungsstatus offener Sendungen bei DHL ab (Rate-Limit beachtet).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({}),
    zusammenfassung: () => 'Sendungsstatus aller offenen Sendungen bei DHL abfragen',
    revalidate: ['/versand'],
  },

  'versand.massendruck': {
    label: 'Massendruck',
    bereich: 'versand',
    beschreibung:
      'Labels für alle gefilterten versandbereiten Lieferungen nach Regelvorschlag; ' +
      'wahlweise direkt ausbuchen (Warenausgang + Shopify-Rückmeldung).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      einzel: z.boolean().default(false).describe('Nur Ein-Positions-Lieferungen'),
      sku: z.string().max(60).default(''),
      land: z.string().max(8).default(''),
      produkt: z.string().max(20).default(''),
      ausbuchen: z.boolean().default(false).describe('Nach dem Label direkt ausbuchen'),
    }),
    formdata: (fd) => ({
      einzel: fd.get('einzel') === 'on',
      sku: String(fd.get('sku') ?? ''),
      land: String(fd.get('land') ?? ''),
      produkt: String(fd.get('produkt') ?? ''),
      ausbuchen: fd.get('ausbuchen') === 'on',
    }),
    revalidate: ['/versand', '/lager'],
  },

  'versand.retourenlabel_erstellen': {
    label: 'Retourenlabel erstellen',
    bereich: 'versand',
    beschreibung: 'Erstellt ein DHL-Retourenlabel für einen Kunden und mailt es ihm zu.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      partner_id: z.string().min(1, 'Bitte einen Kunden auswählen'),
      reference: z.string().max(50).optional(),
    }),
    formdata: (fd) => ({
      partner_id: String(fd.get('partner_id') ?? ''),
      reference: String(fd.get('reference') ?? '') || undefined,
    }),
    revalidate: ['/versand/retouren'],
  },

  // --- Kartonagen (Versand-Konfiguration, nur Admin) -------------------------

  'versand.kartonage_speichern': {
    label: 'Kartonage speichern',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt eine Kartonage an oder ändert sie (mit id) — Bestand, Preis und Leergewicht ' +
      'kommen aus dem verknüpften Bestandsartikel.',
    bindung: 'frei',
    schema: z.object({
      id: z.string().optional().describe('leer = neu anlegen'),
      name: z.string().min(1, 'Die Kartonage braucht einen Namen.').max(120),
      variant_id: z
        .string()
        .min(1, 'Bitte den Bestandsartikel wählen — ohne ihn gibt es keinen Verbrauch zu buchen.'),
      capacity: z.number().positive('Das Fassungsvermögen muss größer als 0 sein.'),
      max_content_g: z.number().int().positive('Das Höchstgewicht muss größer als 0 sein.'),
      kleinpaket: z.boolean().default(false),
      sequence: z.number().int().default(10),
    }),
    zusammenfassung: (p) => `${p.name} (fasst ${p.capacity}, max. ${p.max_content_g} g)`,
    formdata: (fd) => ({
      id: String(fd.get('id') ?? '') || undefined,
      name: String(fd.get('name') ?? '').trim(),
      variant_id: String(fd.get('variant_id') ?? ''),
      capacity: Number(String(fd.get('capacity') ?? '').replace(',', '.')),
      max_content_g: Math.round(Number(fd.get('max_content_g') ?? 0)),
      kleinpaket: fd.get('kleinpaket') === 'on',
      sequence: Math.round(Number(fd.get('sequence') ?? 10)) || 10,
    }),
    revalidate: ['/einstellungen/kartonagen', '/versand'],
  },

  'versand.kartonage_schalten': {
    label: 'Kartonage an/aus',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Schaltet eine Kartonage für die automatische Auswahl an oder ab.',
    bindung: 'beleg',
    schema: z.object({}),
    revalidate: ['/einstellungen/kartonagen', '/versand'],
  },

  'versand.kartonage_loeschen': {
    label: 'Kartonage löschen',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Entfernt die Kartonage — der verknüpfte Bestandsartikel bleibt bestehen.',
    bindung: 'beleg',
    schema: z.object({}),
    revalidate: ['/einstellungen/kartonagen', '/versand'],
  },

  // --- Versandregeln (nur Admin) ---------------------------------------------

  'versand.versandregel_speichern': {
    label: 'Versandregel speichern',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt eine Versandregel an oder ändert sie (mit id): Bedingungen (Gewicht, Zone, SKUs, ' +
      'Kleinpaket-Passform) und mindestens eine Aktion (DHL-Produkt, Abrechnungsnummer oder ' +
      'Versicherung). Regeln werden nach Reihenfolge von oben ausgewertet.',
    bindung: 'frei',
    schema: z
      .object({
        id: z.string().optional().describe('leer = neu anlegen'),
        name: z.string().min(1, 'Die Regel braucht einen Namen.').max(120),
        sequence: z.number().int().default(10),
        min_weight_g: z.number().nullable().default(null),
        max_weight_g: z.number().nullable().default(null),
        zone: z.string().nullable().default(null),
        skus: z.array(z.string()).nullable().default(null),
        sku_scope: z.string().default('any'),
        require_kleinpaket_fit: z.boolean().default(false),
        dhl_product: z.string().nullable().default(null),
        billing_number: z.string().nullable().default(null),
        insurance_from_value: z.number().nullable().default(null),
      })
      .refine(
        (p) => p.dhl_product !== null || p.billing_number !== null || p.insurance_from_value !== null,
        {
          message:
            'Die Regel braucht mindestens eine Aktion (Produkt, Abrechnungsnummer oder Versicherung).',
          path: ['dhl_product'],
        },
      ),
    zusammenfassung: (p) => p.name,
    formdata: (fd) => {
      const zahl = (name: string): number | null => {
        const raw = String(fd.get(name) ?? '').trim().replace(',', '.')
        return raw === '' ? null : Number(raw)
      }
      const skus = String(fd.get('skus') ?? '')
        .split(/[,\n;]/)
        .map((s) => s.trim())
        .filter(Boolean)
      return {
        id: String(fd.get('id') ?? '') || undefined,
        name: String(fd.get('name') ?? '').trim(),
        sequence: zahl('sequence') ?? 10,
        min_weight_g: zahl('min_weight_g'),
        max_weight_g: zahl('max_weight_g'),
        zone: String(fd.get('zone') ?? '') || null,
        skus: skus.length ? skus : null,
        sku_scope: String(fd.get('sku_scope') ?? 'any'),
        require_kleinpaket_fit: fd.get('require_kleinpaket_fit') === 'on',
        dhl_product: String(fd.get('dhl_product') ?? '') || null,
        billing_number: String(fd.get('billing_number') ?? '').trim() || null,
        insurance_from_value: zahl('insurance_from_value'),
      }
    },
    revalidate: ['/einstellungen/versandregeln', '/versand'],
  },

  'versand.versandregel_schalten': {
    label: 'Versandregel an/aus',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Schaltet eine Versandregel an oder ab, ohne sie zu löschen.',
    bindung: 'beleg',
    schema: z.object({}),
    revalidate: ['/einstellungen/versandregeln', '/versand'],
  },

  'versand.versandregel_loeschen': {
    label: 'Versandregel löschen',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Entfernt die Versandregel endgültig.',
    bindung: 'beleg',
    schema: z.object({}),
    revalidate: ['/einstellungen/versandregeln', '/versand'],
  },

  'versand.versandregel_verschieben': {
    label: 'Versandregel verschieben',
    bereich: 'versand',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Tauscht die Auswertungsreihenfolge mit dem Nachbarn — Regeln gelten von oben nach unten.',
    bindung: 'beleg',
    schema: z.object({ richtung: z.enum(['hoch', 'runter']) }),
    revalidate: ['/einstellungen/versandregeln', '/versand'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
