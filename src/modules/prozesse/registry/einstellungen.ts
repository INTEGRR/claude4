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

  'einstellungen.prozess_schalten': {
    label: 'Prozess an/aus',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Schaltet einen ganzen Prozess für diese Firma ab oder wieder an. Abgeschaltete ' +
      'Prozesse verschwinden aus Navigation und Assistenten; Belege und Historie bleiben ' +
      'lesbar. Der Bug-Loop (bug_ticket) ist Infrastruktur und nicht abschaltbar.',
    bindung: 'frei',
    schema: z.object({
      prozess_code: z.string().min(1),
      aktiv: z.boolean(),
    }),
    zusammenfassung: (p) => `${p.prozess_code} → ${p.aktiv ? 'aktiv' : 'abgeschaltet'}`,
    formdata: (fd) => ({
      prozess_code: String(fd.get('prozess_code') ?? ''),
      aktiv: fd.get('aktiv') === 'on' || fd.get('aktiv') === 'true',
    }),
    revalidate: ['/prozesse', '/prozesse/:ergebnis', '/'],
  },

  'einstellungen.paket_aktivieren': {
    label: 'Geschäftsmodell-Paket aktivieren',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Aktiviert ein Geschäftsmodell-Paket: genau die Prozesse des Pakets werden aktiv, ' +
      'alle anderen abgeschaltet (Pivot = Paketwechsel). Der Bug-Loop bleibt immer an; ' +
      'Belege und Historie abgeschalteter Prozesse bleiben lesbar.',
    bindung: 'frei',
    schema: z.object({
      paket_code: z.string().min(1),
    }),
    zusammenfassung: (p) => `Paket ${p.paket_code}`,
    formdata: (fd) => ({ paket_code: String(fd.get('paket_code') ?? '') }),
    revalidate: ['/prozesse', '/'],
  },

  // --- Prozessentwurf (Chamäleon: KI entwirft, Mensch aktiviert) ------------

  'einstellungen.prozess_entwerfen': {
    label: 'Prozess entwerfen',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt eine Prozessversion als ENTWURF an — es wird nichts aktiv: der Mensch prüft das ' +
      'Diagramm auf /prozesse/<code> und aktiviert bewusst. Für einen BESTEHENDEN Prozess ' +
      '(code existiert, egal welcher Beleg) entsteht die nächste Version — zum Umbauen erst ' +
      'die aktuellen Schritte/Übergänge nachschlagen (sql_abfrage auf prozess_schritte/' +
      'prozess_uebergaenge der aktiven Version) und VOLLSTÄNDIG mit Änderungen wieder ' +
      "einreichen. NEUE Prozesse: modell 'vorgang' (Belege VG/… mit frei definierten " +
      "Zuständen) oder ohne modell (beleglose Assistenten). Schritte: genau ein start, " +
      "mindestens ein ende; art 'aktion' braucht eine registrierte Aktion (bei Vorgängen " +
      'zuerst vorgang.anlegen mit params {"prozess_code": "<code>"}, danach ' +
      'vorgang.status_setzen mit params {"state": "<zustand>"} und demselben Wert als ' +
      "zustand), art 'dienst' einen job_kind aus dem Katalog, art 'ereignis' ein Topic. " +
      'Übergänge verbinden Schritt-Codes; Verzweigungen sind mehrere ausgehende Übergänge, ' +
      'optional mit bedingung ({"feld","op","wert"}, Pfade wie zusatz.budget erlaubt). ' +
      'Schleifen sind verboten.',
    bindung: 'frei',
    schema: z.object({
      code: z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z][a-z0-9_]*$/, 'Kleinbuchstaben, Ziffern und Unterstriche'),
      name: z.string().min(1).max(120),
      beschreibung: z.string().max(500).optional(),
      bereich: z.enum([
        'verkauf', 'einkauf', 'fertigung', 'lager', 'versand', 'reparatur',
        'produkte', 'kontakte', 'personal', 'fehler',
      ]),
      modell: z
        .enum(['vorgang'])
        .optional()
        .describe(
          "nur für NEUE Prozesse: 'vorgang' = generische Belege VG/…; leer = belegloser " +
            'Assistent. Bestehende Prozesse behalten ihren Beleg — Feld weglassen.',
        ),
      schritte: z
        .array(
          z.object({
            code: z
              .string()
              .min(1)
              .max(40)
              .regex(/^[a-z][a-z0-9_]*$/, 'Kleinbuchstaben, Ziffern und Unterstriche'),
            name: z.string().min(1).max(80),
            art: z.enum(['start', 'aktion', 'dienst', 'ereignis', 'xor', 'ende']),
            aktion: z.string().optional().describe('Registry-Name, Pflicht bei art=aktion'),
            job_kind: z.string().optional().describe('Job aus dem Katalog, Pflicht bei art=dienst'),
            ereignis: z.string().optional().describe('Topic aus dem Katalog, Pflicht bei art=ereignis'),
            zustand: z
              .string()
              .max(60)
              .optional()
              .describe('Belegzustand nach dem Schritt (je Version eindeutig)'),
            rollen: z.array(z.enum(['admin', 'mitarbeiter', 'lager', 'fertigung'])).optional(),
            params: z
              .record(z.unknown())
              .optional()
              .describe('Vorbelegte Aktionsfelder, z. B. {"state": "geprueft"}'),
            optional: z.boolean().default(false),
          }),
        )
        .min(2)
        .max(30),
      uebergaenge: z
        .array(
          z.object({
            von: z.string().min(1),
            nach: z.string().min(1),
            bedingung: z
              .unknown()
              .optional()
              .describe('{"feld","op","wert"} oder {"alle"/"eine"/"nicht": …}'),
            beschriftung: z.string().max(80).optional(),
          }),
        )
        .min(1)
        .max(60),
    }),
    zusammenfassung: (p) =>
      `${p.code} („${p.name}"): ${p.schritte.length} Schritte, ` +
      `${p.uebergaenge.length} Übergänge — als Entwurf, aktiviert erst nach Prüfung`,
    revalidate: ['/prozesse', '/prozesse/:ergebnis'],
  },

  'einstellungen.prozessversion_aktivieren': {
    label: 'Prozessversion aktivieren',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Prüft einen Entwurf (genau ein Start, alles erreichbar, azyklisch, XOR-Regeln, ' +
      'eindeutige Zustände) und schaltet ihn aktiv — die bisher aktive Version wird ' +
      'archiviert, der Prozess selbst aktiv. Bewusst OHNE ki: das Aktivieren bleibt ein ' +
      'menschlicher Klick nach Blick aufs Diagramm.',
    bindung: 'frei',
    schema: z.object({
      prozess_code: z.string().min(1),
      version: z.number().int().positive(),
    }),
    zusammenfassung: (p) => `${p.prozess_code} → Version ${p.version} aktiv`,
    formdata: (fd) => ({
      prozess_code: String(fd.get('prozess_code') ?? ''),
      version: Number(fd.get('version') ?? 0),
    }),
    revalidate: ['/prozesse', '/prozesse/:ergebnis'],
  },

  // --- Eigene Felder (Chamäleon) --------------------------------------------

  'einstellungen.feld_anlegen': {
    label: 'Eigenes Feld anlegen',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt ein eigenes Feld für ein Modell an (landet im zusatz-jsonb, erscheint in ' +
      'generierten Masken, ist über Bedingungspfade zusatz.<name> prozessfähig).',
    bindung: 'frei',
    schema: z.object({
      modell: z.string().min(1),
      name: z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z][a-z0-9_]*$/, 'Kleinbuchstaben, Ziffern und Unterstriche'),
      label: z.string().min(1).max(80),
      typ: z.enum(['text', 'nummer', 'schalter', 'auswahl', 'datum']),
      pflicht: z.boolean().default(false),
      auswahl: z.array(z.string()).optional().describe('Werte für typ auswahl'),
    }),
    zusammenfassung: (p) => `${p.modell}.${p.name} (${p.typ})`,
    formdata: (fd) => ({
      modell: String(fd.get('modell') ?? ''),
      name: String(fd.get('name') ?? '').trim(),
      label: String(fd.get('label') ?? '').trim(),
      typ: String(fd.get('typ') ?? 'text'),
      pflicht: fd.get('pflicht') === 'on',
      auswahl:
        String(fd.get('auswahl') ?? '')
          .split(/[,\n]/)
          .map((v) => v.trim())
          .filter(Boolean) || undefined,
    }),
    revalidate: ['/prozesse'],
  },

  'einstellungen.feld_loeschen': {
    label: 'Eigenes Feld löschen',
    bereich: 'einstellungen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung: 'Entfernt die Felddefinition — bereits erfasste Werte bleiben im zusatz-jsonb stehen.',
    bindung: 'frei',
    schema: z.object({
      modell: z.string().min(1),
      name: z.string().min(1),
    }),
    revalidate: ['/prozesse'],
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
