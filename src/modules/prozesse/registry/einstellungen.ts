import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Verwaltungsaktionen der Prozesse selbst — das Chamäleon-Stellwerk:
 * eine Firma passt ihre Abläufe zur Laufzeit an, ohne Code anzufassen.
 */
export const EINSTELLUNGEN = {
  'einstellungen.prozessschritt_schalten': {
    label: 'Prozessschritt an/aus',
    bereich: 'einstellungen',
    beschreibung:
      'Schaltet einen OPTIONALEN Prozessschritt für diese Firma ab oder wieder an. ' +
      'Der Override bindet an den Schritt-Code und überlebt damit Versionswechsel; ' +
      'Nachfolger rücken im Ablauf automatisch nach.',
    bindung: 'frei',
    nurAdmin: true,
    prozessfrei: true,
    schema: z.object({
      prozess_code: z.string().min(1),
      schritt_code: z.string().min(1),
      aktiv: z.boolean(),
    }),
    zusammenfassung: (p) =>
      `${p.prozess_code}/${p.schritt_code} → ${p.aktiv ? 'aktiv' : 'abgeschaltet'}`,
    formdata: (fd) => ({
      prozess_code: String(fd.get('prozess_code') ?? ''),
      schritt_code: String(fd.get('schritt_code') ?? ''),
      aktiv: fd.get('aktiv') === 'on' || fd.get('aktiv') === 'true',
    }),
    revalidate: ['/prozesse', '/prozesse/:ergebnis'],
  },

  // --- Benutzerverwaltung (nur Admin) ---------------------------------------

  'einstellungen.benutzer_anlegen': {
    label: 'Benutzer anlegen',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Legt ein Benutzerkonto mit Rolle an (E-Mail eindeutig).',
    bindung: 'frei',
    schema: z.object({
      email: z.string().email('Bitte eine gültige E-Mail-Adresse angeben'),
      name: z.string().min(1, 'Bitte einen Namen angeben').max(100),
      password: z.string().min(8, 'Das Passwort braucht mindestens 8 Zeichen'),
      role: z.enum(['admin', 'mitarbeiter', 'lager', 'fertigung']),
    }),
    zusammenfassung: (p) => `${p.email} (${p.role})`,
    formdata: (fd) => ({
      email: String(fd.get('email') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
      password: String(fd.get('password') ?? ''),
      role: String(fd.get('role') ?? ''),
    }),
    revalidate: ['/einstellungen/benutzer'],
  },

  'einstellungen.benutzer_rolle': {
    label: 'Rolle ändern',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Ändert die Rolle eines Benutzers — der letzte aktive Administrator ist geschützt.',
    bindung: 'beleg',
    schema: z.object({
      role: z.enum(['admin', 'mitarbeiter', 'lager', 'fertigung']),
    }),
    formdata: (fd) => ({ role: String(fd.get('role') ?? '') }),
    revalidate: ['/einstellungen/benutzer'],
  },

  'einstellungen.benutzer_aktiv': {
    label: 'Aktivieren/Deaktivieren',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Aktiviert oder deaktiviert ein Konto; beim Deaktivieren enden laufende Sitzungen sofort.',
    bindung: 'beleg',
    schema: z.object({ active: z.boolean() }),
    revalidate: ['/einstellungen/benutzer'],
  },

  'einstellungen.benutzer_passwort': {
    label: 'Passwort zurücksetzen',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Setzt ein neues Passwort und beendet alle Sitzungen des Kontos.',
    bindung: 'beleg',
    schema: z.object({
      password: z.string().min(8, 'Das Passwort braucht mindestens 8 Zeichen'),
    }),
    formdata: (fd) => ({ password: String(fd.get('password') ?? '') }),
    revalidate: ['/einstellungen/benutzer'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
