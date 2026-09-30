import { z } from 'zod'
import {
  DOKUMENT_ART_NAMEN,
  DOKUMENT_MODELL_NAMEN,
  MAX_DATEI_BYTES,
} from '../../einkauf/dokument-modelle.ts'
import { mailKennungFehler } from '../../einkauf/mail-regeln.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 1 (0092): Dateien in der geteilten Google-Ablage und die
 * Lieferantenakte. Alle prozessfrei — Dokumente begleiten jeden Beleg,
 * gehören aber zu keinem Prozessschritt (Begründung: Ablage ist Querschnitt
 * wie Notizen, Entscheidungslog 2026-09-30).
 *
 * Hochladen in drei Takten: `upload_vorbereiten` legt die Google-Sitzung an
 * (die Adresse bleibt serverseitig), der Browser schickt 4-MiB-Stücke an
 * /api/dokumente/stueck (reiner Transport), `dokument_registrieren` prüft
 * die fertige Datei bei Google (Ordner, Größe) und legt den Index an — der
 * Datei-ID aus dem Browser wird nie ungeprüft geglaubt.
 */

const uuid = z.string().uuid()

export const EINKAUF_DOKUMENTE = {
  'einkauf.ablage_einrichten': {
    label: 'Einkaufsablage einrichten',
    bereich: 'einkauf',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Legt in der geteilten Google-Ablage „Einkauf" die Hauptordner an (Lieferanten, ' +
      'Projekte, Artikel, Eingang). Wiederholbar — vorhandene Ordner werden gefunden, nicht verdoppelt.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/einstellungen/anbindungen'],
  },

  'einkauf.upload_vorbereiten': {
    label: 'Datei-Upload vorbereiten',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Beginnt das Hochladen einer Datei an einen Beleg: legt beim Google-Drive die ' +
      'Upload-Sitzung im Ordner des Belegs an und gibt die Sitzungs-ID zurück.',
    bindung: 'frei',
    schema: z.object({
      name: z.string().trim().min(1).max(255),
      mime: z.string().max(200).optional(),
      groesse: z.number().int().positive().max(MAX_DATEI_BYTES, 'Die Datei ist größer als 2 GB.'),
      modell: z.enum(DOKUMENT_MODELL_NAMEN),
      record_id: uuid,
      art: z.enum(DOKUMENT_ART_NAMEN).optional(),
    }),
    zusammenfassung: (p) => `Upload „${p.name}"`,
  },

  'einkauf.dokument_registrieren': {
    label: 'Hochgeladene Datei übernehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Schließt einen Upload ab: prüft die Datei bei Google (Ordner und Größe der Sitzung) ' +
      'und legt sie im Dokumentenindex an, verknüpft mit dem Beleg.',
    bindung: 'frei',
    schema: z.object({
      sitzung_id: uuid,
      drive_file_id: z.string().min(5).max(200),
      revision: z.string().max(40).optional(),
      notiz: z.string().max(500).optional(),
    }),
  },

  'einkauf.dokument_verknuepfen': {
    label: 'Dokument mit Beleg verknüpfen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Hängt ein vorhandenes Dokument zusätzlich an einen weiteren Beleg (z. B. die ' +
      'Zeichnung eines Artikels an eine Bestellung). Die Datei bleibt, wo sie ist.',
    bindung: 'frei',
    schema: z.object({
      dokument_id: uuid,
      modell: z.enum(DOKUMENT_MODELL_NAMEN),
      record_id: uuid,
    }),
    zusammenfassung: (p) => `Dokument an ${p.modell} hängen`,
  },

  'einkauf.dokument_loesen': {
    label: 'Dokument vom Beleg lösen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Entfernt die Verknüpfung eines Dokuments mit einem Beleg. Die Datei in Drive und ' +
      'andere Verknüpfungen bleiben erhalten.',
    bindung: 'frei',
    schema: z.object({
      dokument_id: uuid,
      modell: z.enum(DOKUMENT_MODELL_NAMEN),
      record_id: uuid,
    }),
  },

  'einkauf.dokument_aendern': {
    label: 'Dokument beschreiben',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung: 'Setzt Art (Zeichnung, PI, Rechnung …), Revision und Notiz eines Dokuments.',
    bindung: 'frei',
    schema: z.object({
      dokument_id: uuid,
      art: z.enum(DOKUMENT_ART_NAMEN).optional(),
      revision: z.string().max(40).optional(),
      notiz: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      ['Dokument beschreiben', p.art && `Art ${p.art}`, p.revision && `Rev. ${p.revision}`].filter(Boolean).join(' · '),
    formdata: (fd) => ({
      dokument_id: String(fd.get('dokument_id') ?? ''),
      art: (String(fd.get('art') ?? '') || undefined) as never,
      revision: fd.has('revision') ? String(fd.get('revision') ?? '').trim() : undefined,
      notiz: fd.has('notiz') ? String(fd.get('notiz') ?? '').trim() : undefined,
    }),
  },

  'einkauf.lieferantendaten_setzen': {
    label: 'Einkaufsdaten des Lieferanten setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Pflegt die Lieferantenakte: Kommunikationssprache (de/en/zh), Maildomains bzw. bei ' +
      'Freemailern (qq.com, 163.com …) volle Adressen für die automatische Zuordnung ' +
      'eingehender Mails, zuständiger Einkäufer, Standard-Incoterm ' +
      'und -Währung. Macht den Kontakt zugleich zum Lieferanten.',
    bindung: 'beleg',
    modell: 'partner',
    schema: z.object({
      sprache: z.enum(['de', 'en', 'zh']).optional(),
      mail_domains: z
        .array(
          z.string().trim().toLowerCase().superRefine((e, c) => {
            const fehler = mailKennungFehler(e)
            if (fehler) c.addIssue({ code: 'custom', message: fehler })
          }),
        )
        .max(20)
        .default([]),
      einkaeufer_id: uuid.optional(),
      standard_incoterm: z.string().max(3).optional(),
      standard_waehrung: z.string().length(3).optional(),
    }),
    formdata: (fd) => ({
      sprache: (String(fd.get('sprache') ?? '') || undefined) as never,
      mail_domains: String(fd.get('mail_domains') ?? '')
        .split(/[\s,;]+/)
        .map((d) => d.trim().replace(/^@/, ''))
        .filter(Boolean),
      einkaeufer_id: String(fd.get('einkaeufer_id') ?? '') || undefined,
      standard_incoterm: String(fd.get('standard_incoterm') ?? '') || undefined,
      standard_waehrung: String(fd.get('standard_waehrung') ?? '') || undefined,
    }),
    revalidate: ['/einkauf/lieferanten/:id', '/einkauf/lieferanten', '/kontakte/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
