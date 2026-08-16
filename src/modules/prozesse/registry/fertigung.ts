import { z } from 'zod'
import { parseQtyMap } from '../../shared/form.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen der Fertigung: Fertigungsaufträge, Demontage, Stücklisten,
 * Arbeitsplätze und Arbeitsgänge. Die Auftrags-Statusübergänge stehen auf
 * der Restliste, bis der Fertigungsprozess (P5) gesät ist; Stammdaten-
 * pflege (Stücklisten, Arbeitsplätze) ist prozessfreies Werkzeug.
 */
export const FERTIGUNG = {
  'fertigung.auftrag_anlegen': {
    label: 'Fertigungsauftrag anlegen',
    bereich: 'fertigung',
    beschreibung:
      'Legt einen Fertigungsauftrag im Entwurf an — die Stückliste wird aufgelöst, der Komponentenbedarf eingefroren.',
    bindung: 'frei',
    modell: 'manufacturing_order',
    uebergang: { von: [], nach: ['draft'] },
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
    }),
    revalidate: ['/fertigung'],
  },

  'fertigung.bestaetigen': {
    label: 'Auftrag bestätigen',
    bereich: 'fertigung',
    beschreibung: 'Bestätigt den Fertigungsauftrag — die Komponentenbewegungen entstehen.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    uebergang: { von: ['draft'], nach: ['confirmed'] },
    schema: z.object({}),
    revalidate: ['/fertigung/:id'],
  },

  'fertigung.beginnen': {
    label: 'Fertigung starten',
    bereich: 'fertigung',
    beschreibung: 'Setzt den Auftrag auf „in Arbeit".',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    uebergang: { von: ['confirmed'], nach: ['progress'] },
    schema: z.object({}),
    revalidate: ['/fertigung/:id'],
  },

  'fertigung.verfuegbarkeit_pruefen': {
    label: 'Verfügbarkeit prüfen',
    bereich: 'fertigung',
    beschreibung: 'Reserviert Komponenten erneut — holt inzwischen eingetroffenen Bestand in den Auftrag.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    uebergang: { von: ['confirmed', 'progress'], nach: ['confirmed', 'progress'] },
    schema: z.object({}),
    revalidate: ['/fertigung/:id'],
  },

  'fertigung.fertig_melden': {
    label: 'Fertig melden',
    bereich: 'fertigung',
    beschreibung:
      'Meldet die Produktion fertig: Komponenten werden verbraucht (Backflush oder Ist-Mengen), das Erzeugnis geht ins Lager.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    uebergang: { von: ['confirmed', 'progress'], nach: ['done', 'progress'] },
    schema: z.object({
      qty: z.number().positive().optional().describe('Ist-Menge; leer = offene Sollmenge'),
      mengen: z.record(z.number()).default({}).describe('Ist-Verbrauch je Bewegung'),
      backorder: z.boolean().default(true),
      lot: z.string().max(60).optional().describe('Los/Serie des Erzeugnisses'),
    }),
    formdata: (fd) => ({
      qty: fd.get('qty') ? Number(fd.get('qty')) : undefined,
      mengen: parseQtyMap(fd, 'consumed_'),
      backorder: fd.get('backorder') !== 'no',
      lot: String(fd.get('lot') ?? '').trim() || undefined,
    }),
    revalidate: ['/fertigung/:id', '/fertigung', '/versand'],
  },

  'fertigung.stornieren': {
    label: 'Auftrag stornieren',
    bereich: 'fertigung',
    beschreibung: 'Storniert den Fertigungsauftrag und gibt Reservierungen frei.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    uebergang: { von: ['draft', 'confirmed', 'progress'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/fertigung/:id'],
  },

  // --- Arbeitsgänge am Auftrag ---------------------------------------------

  'fertigung.arbeitsgang_starten': {
    label: 'Arbeitsgang starten',
    bereich: 'fertigung',
    beschreibung:
      'Startet einen Arbeitsgang (setzt den Auftrag auf „in Arbeit"); mit Mitarbeiter läuft die Zeiterfassung mit.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    schema: z.object({
      operation_id: z.string().min(1),
      employee_id: z.string().optional(),
    }),
    formdata: (fd) => ({
      operation_id: String(fd.get('operation_id') ?? ''),
      employee_id: String(fd.get('employee_id') ?? '').trim() || undefined,
    }),
    revalidate: ['/fertigung/:id', '/zeiterfassung'],
  },

  'fertigung.arbeitsgang_beenden': {
    label: 'Arbeitsgang beenden',
    bereich: 'fertigung',
    beschreibung: 'Beendet einen Arbeitsgang — ohne Minutenangabe zählt die Zeit seit dem Start.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    schema: z.object({
      operation_id: z.string().min(1),
      minutes: z.number().nonnegative('Bitte eine gültige Dauer in Minuten erfassen').optional(),
    }),
    formdata: (fd) => ({
      operation_id: String(fd.get('operation_id') ?? ''),
      minutes:
        String(fd.get('minutes') ?? '').trim() === ''
          ? undefined
          : Number(fd.get('minutes')),
    }),
    revalidate: ['/fertigung/:id', '/zeiterfassung'],
  },

  // --- Demontage -------------------------------------------------------------

  'fertigung.demontage_anlegen': {
    label: 'Demontageauftrag anlegen',
    bereich: 'fertigung',
    beschreibung: 'Legt einen Demontageauftrag an (Stückliste rückwärts).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
    }),
    revalidate: ['/fertigung/demontage'],
  },

  'fertigung.demontage_buchen': {
    label: 'Demontage buchen',
    bereich: 'fertigung',
    beschreibung: 'Bucht die Demontage: Erzeugnis raus, Komponenten zurück ins Lager.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({ force: z.boolean().default(false) }),
    revalidate: ['/fertigung/demontage'],
  },

  // --- Stücklisten -----------------------------------------------------------

  'fertigung.stueckliste_anlegen': {
    label: 'Stückliste anlegen',
    bereich: 'fertigung',
    beschreibung: 'Legt eine Stückliste für ein Produkt an.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      template_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive().default(1),
    }),
    formdata: (fd) => ({
      template_id: String(fd.get('template_id') ?? ''),
      qty: Number(fd.get('qty') ?? 1) || 1,
    }),
    revalidate: ['/fertigung/stuecklisten'],
  },

  'fertigung.stueckliste_position_hinzufuegen': {
    label: 'Komponente hinzufügen',
    bereich: 'fertigung',
    beschreibung: 'Nimmt eine Komponente in die Stückliste auf, wahlweise nur für bestimmte Varianten.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      component_variant_id: z.string().min(1, 'Bitte eine Komponente auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
      issue_method: z.enum(['backflush', 'manual']).default('backflush'),
      ptav_ids: z.array(z.string()).default([]),
    }),
    formdata: (fd) => ({
      component_variant_id: String(fd.get('component_variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
      issue_method: fd.get('issue_method') === 'manual' ? 'manual' : 'backflush',
      ptav_ids: fd.getAll('ptav_ids').map(String).filter(Boolean),
    }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },

  'fertigung.stueckliste_position_entfernen': {
    label: 'Komponente entfernen',
    bereich: 'fertigung',
    beschreibung: 'Entfernt eine Komponente aus der Stückliste.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({ line_id: z.string().min(1) }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },

  'fertigung.stueckliste_verbrauch': {
    label: 'Verbrauchsregel setzen',
    bereich: 'fertigung',
    beschreibung: 'Wie streng werden Abweichungen vom Sollverbrauch behandelt (frei/warnen/sperren).',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({ consumption: z.string().default('warning') }),
    formdata: (fd) => ({ consumption: String(fd.get('consumption') ?? 'warning') }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },

  'fertigung.stueckliste_verbrauchsart': {
    label: 'Verbrauchsart umstellen',
    bereich: 'fertigung',
    beschreibung: 'Backflush ⇄ manuelle Erfassung je Stücklistenposition.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      line_id: z.string().min(1),
      method: z.enum(['backflush', 'manual']),
    }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },

  'fertigung.auftrag_details': {
    label: 'Verantwortlich/Priorität',
    bereich: 'fertigung',
    beschreibung: 'Setzt Verantwortlichen und Priorität des Fertigungsauftrags.',
    bindung: 'beleg',
    modell: 'manufacturing_order',
    prozessfrei: true,
    schema: z.object({
      user_id: z.string().optional(),
      priority: z.boolean().default(false),
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      priority: fd.get('priority') === 'on',
    }),
    revalidate: ['/fertigung/:id'],
  },

  // --- Arbeitsplätze + Arbeitsgänge an der Stückliste ------------------------

  'fertigung.arbeitsplatz_anlegen': {
    label: 'Arbeitsplatz anlegen',
    bereich: 'fertigung',
    beschreibung: 'Legt einen Arbeitsplatz mit Kostensatz, Kapazität und Effizienz an.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      code: z.string().min(1, 'Bitte ein Kürzel vergeben').max(20),
      name: z.string().min(1, 'Bitte einen Namen vergeben').max(100),
      cost_per_hour: z.number().nonnegative().default(0),
      capacity: z.number().positive().default(1),
      time_efficiency: z.number().positive().default(100),
      note: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      code: String(fd.get('code') ?? '').trim().toUpperCase(),
      name: String(fd.get('name') ?? '').trim(),
      cost_per_hour: Number(fd.get('cost_per_hour') ?? 0) || 0,
      capacity: Number(fd.get('capacity') ?? 1) || 1,
      time_efficiency: Number(fd.get('time_efficiency') ?? 100) || 100,
      note: String(fd.get('note') ?? '').trim() || undefined,
    }),
    revalidate: ['/fertigung/arbeitsplaetze'],
  },

  'fertigung.arbeitsplatz_aendern': {
    label: 'Arbeitsplatz ändern',
    bereich: 'fertigung',
    beschreibung: 'Ändert Name, Kostensatz, Kapazität, Effizienz und Aktiv-Status eines Arbeitsplatzes.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1).max(100),
      cost_per_hour: z.number().nonnegative().default(0),
      capacity: z.number().positive().default(1),
      time_efficiency: z.number().positive().default(100),
      active: z.boolean().default(true),
      note: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      cost_per_hour: Number(fd.get('cost_per_hour') ?? 0) || 0,
      capacity: Number(fd.get('capacity') ?? 1) || 1,
      time_efficiency: Number(fd.get('time_efficiency') ?? 100) || 100,
      active: fd.get('active') === 'on',
      note: String(fd.get('note') ?? '').trim() || undefined,
    }),
    revalidate: ['/fertigung/arbeitsplaetze'],
  },

  'fertigung.arbeitsgang_hinzufuegen': {
    label: 'Arbeitsgang hinzufügen',
    bereich: 'fertigung',
    beschreibung: 'Nimmt einen Arbeitsgang (Arbeitsplatz, Dauer, Rüstzeit) in die Stückliste auf.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte den Arbeitsgang benennen').max(100),
      work_center_id: z.string().min(1, 'Bitte einen Arbeitsplatz auswählen'),
      duration_minutes: z.number().nonnegative().default(0),
      setup_minutes: z.number().nonnegative().default(0),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      work_center_id: String(fd.get('work_center_id') ?? ''),
      duration_minutes: Number(fd.get('duration_minutes') ?? 0) || 0,
      setup_minutes: Number(fd.get('setup_minutes') ?? 0) || 0,
    }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },

  'fertigung.arbeitsgang_entfernen': {
    label: 'Arbeitsgang entfernen',
    bereich: 'fertigung',
    beschreibung: 'Entfernt einen Arbeitsgang aus der Stückliste.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({ operation_id: z.string().min(1) }),
    revalidate: ['/fertigung/stuecklisten/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
