import { z } from 'zod'
import type { Area } from '../../auth/permissions.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * DIE Notiz-Aktion des Hauses: das Kommentarfeld der Detailseiten und die
 * KI-Notiz laufen über denselben Torwächter-Weg (Entscheidungslog
 * 2026-08-27). Kommentare landen als 'note' im audit_log — dieselbe Quelle,
 * aus der der Verlauf auf den Detailseiten gespeist wird.
 *
 * Bereich 'fehler', weil das der einzige Bereich mit Schreibrecht ALLER
 * Rollen ist: Kommentieren darf grundsätzlich jeder — WO, entscheidet die
 * canAccess-Prüfung je Modell im Executor (auch Lese-Rollen dürfen dort
 * kommentieren, wo sie lesen dürfen; das ist die alte Kommentar-Semantik).
 */

/** Die kommentierbaren Modelle mit Tabelle (Existenz-Check) und Bereich (Rechte). */
export const KOMMENTAR_MODELLE = {
  sales_order: { tabelle: 'sales_orders', bereich: 'verkauf' },
  purchase_order: { tabelle: 'purchase_orders', bereich: 'einkauf' },
  vendor_bill: { tabelle: 'vendor_bills', bereich: 'einkauf' },
  manufacturing_order: { tabelle: 'manufacturing_orders', bereich: 'fertigung' },
  bom: { tabelle: 'boms', bereich: 'fertigung' },
  unbuild_order: { tabelle: 'unbuild_orders', bereich: 'fertigung' },
  stock_picking: { tabelle: 'stock_pickings', bereich: 'lager' },
  repair_order: { tabelle: 'repair_orders', bereich: 'reparatur' },
  product_template: { tabelle: 'product_templates', bereich: 'produkte' },
  product_variant: { tabelle: 'product_variants', bereich: 'produkte' },
  partner: { tabelle: 'partners', bereich: 'kontakte' },
  shipment: { tabelle: 'shipments', bereich: 'versand' },
  vorgang: { tabelle: 'vorgaenge', bereich: 'verkauf' },
  vertrag: { tabelle: 'vertraege', bereich: 'finanzen' },
  darlehen: { tabelle: 'darlehen', bereich: 'finanzen' },
  employee: { tabelle: 'employees', bereich: 'personal' },
  bug_report: { tabelle: 'bug_reports', bereich: 'fehler' },
} satisfies Record<string, { tabelle: string; bereich: Area }>

/**
 * Die kommentierbaren Modelle als Typ — er koppelt die Allowlist an ihre
 * Aufrufer: eine Detailseite mit einem hier fehlenden Modell bricht den
 * Typecheck (die Lehre aus fünf Seiten, deren Kommentarfeld nur zur
 * Laufzeit scheiterte).
 */
export type KommentarModell = keyof typeof KOMMENTAR_MODELLE

const MODELL_NAMEN = Object.keys(KOMMENTAR_MODELLE) as [KommentarModell, ...KommentarModell[]]

export const NOTIZEN = {
  'notiz.anlegen': {
    label: 'Notiz an einem Datensatz',
    bereich: 'fehler',
    ki: true,
    beschreibung:
      'Hängt eine Notiz an den Verlauf eines Datensatzes (record_id + model), z. B. an ' +
      'einen Verkaufsauftrag oder ein Produkt. Ändert keine Daten.',
    bindung: 'beleg',
    // Kein `modell`: die Aktion ist polymorph, der Existenz-Check läuft
    // je Modell im Executor.
    prozessfrei: true,
    schema: z.object({
      model: z.enum(MODELL_NAMEN),
      text: z.string().min(1).max(2000, 'Der Kommentar ist zu lang (max. 2000 Zeichen)'),
    }),
    zusammenfassung: (p) => `Notiz an ${p.model}: „${p.text.slice(0, 120)}"`,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
