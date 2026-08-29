import { z } from 'zod'
import { geld, type RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Personalbereichs: Mitarbeiterstamm, Stempeluhr, Nachträge,
 * Schichtplan und Abwesenheiten. Alles prozessfreie Werkzeuge — die
 * Abwesenheit trägt ihre Statusmaschine als Übergangs-Metadatum und ist
 * ein Kandidat für einen späteren Vorgangs-Prozess (Phase 7).
 */
export const PERSONAL = {
  'personal.mitarbeiter_anlegen': {
    label: 'Mitarbeiter anlegen',
    bereich: 'personal',
    ki: true,
    beschreibung: 'Legt einen Mitarbeiter mit Stammdaten, Kostensatz und Wochenstunden an.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(100),
      barcode: z.string().max(60).optional(),
      job_title: z.string().max(100).optional(),
      department: z.string().max(100).optional(),
      employment_type: z.string().default('full_time'),
      hourly_cost: z.number().nonnegative().default(0),
      weekly_hours: z.number().nonnegative().default(40),
      vacation_days: z.number().nonnegative().default(30),
      hire_date: z.string().optional(),
      email: z.string().max(200).optional(),
      phone: z.string().max(60).optional(),
    }),
    zusammenfassung: (p) =>
      `${p.name}${p.job_title ? ` — ${p.job_title}` : ''}` +
      (p.hourly_cost ? `, ${geld(p.hourly_cost)} je Stunde` : ''),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      barcode: String(fd.get('barcode') ?? '').trim() || undefined,
      job_title: String(fd.get('job_title') ?? '').trim() || undefined,
      department: String(fd.get('department') ?? '').trim() || undefined,
      employment_type: String(fd.get('employment_type') ?? 'full_time'),
      hourly_cost: Number(fd.get('hourly_cost') ?? 0) || 0,
      weekly_hours: Number(fd.get('weekly_hours') ?? 40) || 0,
      vacation_days: Number(fd.get('vacation_days') ?? 30) || 0,
      hire_date: String(fd.get('hire_date') ?? '').trim() || undefined,
      email: String(fd.get('email') ?? '').trim() || undefined,
      phone: String(fd.get('phone') ?? '').trim() || undefined,
    }),
    revalidate: ['/personal'],
  },

  'personal.mitarbeiter_aendern': {
    label: 'Mitarbeiter ändern',
    bereich: 'personal',
    beschreibung: 'Ändert Stammdaten, Benutzerverknüpfung, Kostensatz und Aktiv-Status.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(100),
      barcode: z.string().max(60).optional(),
      user_id: z.string().optional(),
      job_title: z.string().max(100).optional(),
      department: z.string().max(100).optional(),
      employment_type: z.string().default('full_time'),
      hourly_cost: z.number().nonnegative().default(0),
      weekly_hours: z.number().nonnegative().default(0),
      vacation_days: z.number().nonnegative().default(0),
      hire_date: z.string().optional(),
      exit_date: z.string().optional(),
      email: z.string().max(200).optional(),
      phone: z.string().max(60).optional(),
      note: z.string().max(2000).optional(),
      active: z.boolean().default(true),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      barcode: String(fd.get('barcode') ?? '').trim() || undefined,
      user_id: String(fd.get('user_id') ?? '').trim() || undefined,
      job_title: String(fd.get('job_title') ?? '').trim() || undefined,
      department: String(fd.get('department') ?? '').trim() || undefined,
      employment_type: String(fd.get('employment_type') ?? 'full_time'),
      hourly_cost: Number(fd.get('hourly_cost') ?? 0) || 0,
      weekly_hours: Number(fd.get('weekly_hours') ?? 0) || 0,
      vacation_days: Number(fd.get('vacation_days') ?? 0) || 0,
      hire_date: String(fd.get('hire_date') ?? '').trim() || undefined,
      exit_date: String(fd.get('exit_date') ?? '').trim() || undefined,
      email: String(fd.get('email') ?? '').trim() || undefined,
      phone: String(fd.get('phone') ?? '').trim() || undefined,
      note: String(fd.get('note') ?? '').trim() || undefined,
      active: fd.get('active') === 'on',
    }),
    revalidate: ['/personal/:id', '/personal'],
  },

  // --- Stempeluhr ----------------------------------------------------------

  'zeiterfassung.stempeln': {
    label: 'Kommen/Gehen',
    bereich: 'zeiterfassung',
    beschreibung: 'Stempelt einen Mitarbeiter ein oder aus (per Knopf am Mitarbeiter).',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/zeiterfassung', '/personal'],
  },

  'zeiterfassung.stempeln_barcode': {
    label: 'Stempeln per Ausweis',
    bereich: 'zeiterfassung',
    beschreibung: 'Kommen/Gehen per Ausweis-Barcode — der Normalfall am Terminal.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      barcode: z.string().min(1, 'Bitte einen Ausweis scannen'),
    }),
    formdata: (fd) => ({ barcode: String(fd.get('barcode') ?? '').trim() }),
    revalidate: ['/zeiterfassung'],
  },

  'zeiterfassung.buchung_beenden': {
    label: 'Buchung beenden',
    bereich: 'zeiterfassung',
    beschreibung: 'Beendet eine laufende Zeitbuchung, optional mit Pausenzeit.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      break_minutes: z.number().nonnegative('Bitte eine gültige Pausenzeit erfassen').optional(),
    }),
    formdata: (fd) => ({
      break_minutes:
        String(fd.get('break_minutes') ?? '').trim() === ''
          ? undefined
          : Number(fd.get('break_minutes')),
    }),
    revalidate: ['/zeiterfassung', '/personal'],
  },

  'personal.zeit_nachtragen': {
    label: 'Zeit nachtragen',
    bereich: 'personal',
    beschreibung: 'Nachtrag für vergessene Buchungen (nur Büro) — Kostensatz vom Mitarbeiter.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      employee_id: z.string().min(1, 'Bitte einen Mitarbeiter auswählen'),
      started_at: z.string().min(1, 'Bitte Beginn und Ende angeben'),
      ended_at: z.string().min(1, 'Bitte Beginn und Ende angeben'),
      break_minutes: z.number().nonnegative().default(0),
      note: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      employee_id: String(fd.get('employee_id') ?? '').trim(),
      started_at: String(fd.get('started_at') ?? '').trim(),
      ended_at: String(fd.get('ended_at') ?? '').trim(),
      break_minutes: Number(fd.get('break_minutes') ?? 0) || 0,
      note: String(fd.get('note') ?? '').trim() || undefined,
    }),
    revalidate: ['/zeiterfassung', '/personal/:ergebnis'],
  },

  'personal.zeit_loeschen': {
    label: 'Zeitbuchung löschen',
    bereich: 'personal',
    beschreibung: 'Löscht eine Zeitbuchung — Produktionszeiten (am Arbeitsgang) sind geschützt.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({ entry_id: z.string().min(1) }),
    revalidate: ['/personal/:id', '/zeiterfassung'],
  },

  // --- Schichtplan ---------------------------------------------------------

  'personal.schicht_planen': {
    label: 'Schicht planen',
    bereich: 'personal',
    beschreibung: 'Plant eine Schicht aus einer Vorlage für einen Mitarbeiter an einem Tag.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      employee_id: z.string().min(1, 'Bitte einen Mitarbeiter auswählen'),
      template_id: z.string().min(1, 'Bitte eine Schicht auswählen'),
      day: z.string().min(1, 'Bitte einen Tag auswählen'),
      work_center_id: z.string().optional(),
      note: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      employee_id: String(fd.get('employee_id') ?? '').trim(),
      template_id: String(fd.get('template_id') ?? '').trim(),
      day: String(fd.get('day') ?? '').trim(),
      work_center_id: String(fd.get('work_center_id') ?? '').trim() || undefined,
      note: String(fd.get('note') ?? '').trim() || undefined,
    }),
    revalidate: ['/personal/schichtplan'],
  },

  'personal.schicht_loeschen': {
    label: 'Schicht löschen',
    bereich: 'personal',
    beschreibung: 'Entfernt eine geplante Schicht.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/personal/schichtplan'],
  },

  // --- Abwesenheiten -------------------------------------------------------

  'personal.abwesenheit_beantragen': {
    label: 'Abwesenheit beantragen',
    bereich: 'personal',
    beschreibung: 'Erfasst einen Abwesenheitsantrag (Urlaub, krank, …), halbtags möglich.',
    bindung: 'frei',
    modell: 'absence',
    uebergang: { von: [], nach: ['requested'] },
    prozessfrei: true,
    schema: z.object({
      employee_id: z.string().min(1, 'Bitte einen Mitarbeiter auswählen'),
      kind: z.string().default('vacation'),
      starts_on: z.string().min(1, 'Bitte den Zeitraum angeben'),
      ends_on: z.string().min(1, 'Bitte den Zeitraum angeben'),
      half_day: z.boolean().default(false),
      reason: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      employee_id: String(fd.get('employee_id') ?? '').trim(),
      kind: String(fd.get('kind') ?? 'vacation'),
      starts_on: String(fd.get('starts_on') ?? '').trim(),
      ends_on: String(fd.get('ends_on') ?? '').trim(),
      half_day: fd.get('half_day') === 'on',
      reason: String(fd.get('reason') ?? '').trim() || undefined,
    }),
    revalidate: ['/personal/abwesenheiten'],
  },

  'personal.abwesenheit_entscheiden': {
    label: 'Abwesenheit entscheiden',
    bereich: 'personal',
    beschreibung: 'Genehmigt, lehnt ab oder storniert einen Abwesenheitsantrag.',
    bindung: 'beleg',
    modell: 'absence',
    uebergang: { von: ['requested', 'approved'], nach: ['approved', 'rejected', 'cancel'] },
    prozessfrei: true,
    schema: z.object({
      state: z.enum(['approved', 'rejected', 'cancel']),
    }),
    zusammenfassung: (p) =>
      p.state === 'approved' ? 'genehmigen' : p.state === 'rejected' ? 'ablehnen' : 'stornieren',
    revalidate: ['/personal/abwesenheiten', '/personal'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
