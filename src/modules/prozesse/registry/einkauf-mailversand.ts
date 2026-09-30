import { z } from 'zod'
import { VORLAGEN_ANLASS_NAMEN } from '../../einkauf/mail-vorlagen.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 2b (0094): Mails an Lieferanten als Beleg `mail_entwurf`
 * im Prozess `mail_versand` — Entwurf schreiben (von Hand, aus Vorlage in
 * der Sprache des Lieferanten, aus der Bestellung mit PDF), freigeben,
 * senden (Dienst gmail_senden) oder verwerfen. Freigeben ist bewusst NICHT
 * `ki`: Der Agent (Stufe 6) darf Entwürfe schreiben, senden tut ein Mensch.
 * Ändern und Übersetzen sind prozessfrei (Arbeit am Entwurf, kein Schritt).
 */

const uuid = z.string().uuid()
const email = z.string().trim().toLowerCase().email('Ungültige Mailadresse')
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')

const adressListe = (roh: FormDataEntryValue | null) =>
  String(roh ?? '')
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean)

const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined

export const EINKAUF_MAILVERSAND = {
  'einkauf.mail_entwurf_anlegen': {
    label: 'Mail an Lieferanten entwerfen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Legt einen Mail-Entwurf an: als Antwort in einem Thread (Empfänger, Betreff und Thread-Köpfe ' +
      'kommen aus dem Gespräch) oder neu an einen Lieferanten bzw. zu einer Bestellung. Mit Vorlage ' +
      '(Anfrage, PI anfordern, Liefertermin & Tracking, Muster-Feedback, Bestellung) entstehen der ' +
      'deutsche Text und der Text in der Sprache des Lieferanten; mit bestell_pdf hängt das ' +
      'Bestell-PDF an. Gesendet wird erst nach Freigabe durch einen Menschen.',
    bindung: 'frei',
    schema: z
      .object({
        thread_id: uuid.optional(),
        partner_id: uuid.optional(),
        purchase_order_id: uuid.optional(),
        vorlage: z.enum(VORLAGEN_ANLASS_NAMEN).optional(),
        sprache: z.enum(['de', 'en', 'zh']).optional(),
        an: z.array(email).max(20).optional(),
        cc: z.array(email).max(20).optional(),
        betreff: z.string().trim().max(300).optional(),
        text_de: z.string().max(50_000).optional(),
        text_ziel: z.string().max(50_000).optional(),
        anhang_dokument_ids: z.array(uuid).max(30).default([]),
        antwort_erwartet_bis: datum.optional(),
        bestell_pdf: z.boolean().default(false),
        einkaufsprojekt_id: uuid.optional().describe('Einkaufsprojekt, zu dem die Mail gehört (Thread hängt danach am Projekt)'),
      })
      .refine(
        (p) => p.thread_id || p.partner_id || p.purchase_order_id || p.an?.length,
        'Bitte Thread, Lieferant, Bestellung oder Empfänger angeben.',
      ),
    zusammenfassung: (p) =>
      ['Mail entwerfen', p.vorlage && `Vorlage ${p.vorlage}`, p.thread_id && 'Antwort im Thread', p.bestell_pdf && 'mit Bestell-PDF']
        .filter(Boolean)
        .join(' · '),
    formdata: (fd) => ({
      thread_id: leer(fd, 'thread_id'),
      partner_id: leer(fd, 'partner_id'),
      purchase_order_id: leer(fd, 'purchase_order_id'),
      vorlage: leer(fd, 'vorlage') as never,
      sprache: leer(fd, 'sprache') as never,
      bestell_pdf: fd.get('bestell_pdf') === 'on' || fd.get('bestell_pdf') === 'true',
      einkaufsprojekt_id: leer(fd, 'einkaufsprojekt_id'),
    }),
    revalidate: ['/einkauf/entwuerfe'],
  },

  'einkauf.mail_entwurf_aendern': {
    label: 'Mail-Entwurf bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ändert einen Entwurf, solange er nicht freigegeben ist: Empfänger, Betreff, deutschen Text, ' +
      'Text in der Zielsprache, Sprache, Anhänge aus der Ablage und „Antwort erwartet bis".',
    bindung: 'beleg',
    modell: 'mail_entwurf',
    schema: z.object({
      an: z.array(email).max(20).optional(),
      cc: z.array(email).max(20).optional(),
      betreff: z.string().trim().max(300).optional(),
      text_de: z.string().max(50_000).optional(),
      text_ziel: z.string().max(50_000).optional(),
      sprache: z.enum(['de', 'en', 'zh']).optional(),
      anhang_dokument_ids: z.array(uuid).max(30).optional(),
      antwort_erwartet_bis: z.union([datum, z.literal('')]).optional(),
    }),
    zusammenfassung: () => 'Entwurf bearbeiten',
    formdata: (fd) => ({
      an: fd.has('an') ? adressListe(fd.get('an')) : undefined,
      cc: fd.has('cc') ? adressListe(fd.get('cc')) : undefined,
      betreff: fd.has('betreff') ? String(fd.get('betreff') ?? '') : undefined,
      text_de: fd.has('text_de') ? String(fd.get('text_de') ?? '') : undefined,
      text_ziel: fd.has('text_ziel') ? String(fd.get('text_ziel') ?? '') : undefined,
      sprache: leer(fd, 'sprache') as never,
      anhang_dokument_ids: fd.has('anhaenge_gezeigt') ? fd.getAll('anhang').map(String) : undefined,
      antwort_erwartet_bis: fd.has('antwort_erwartet_bis') ? String(fd.get('antwort_erwartet_bis') ?? '') : undefined,
    }),
    revalidate: ['/einkauf/entwuerfe/:id'],
  },

  'einkauf.mail_uebersetzen': {
    label: 'Entwurf übersetzen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Übersetzt den deutschen Text eines Entwurfs in die Sprache des Lieferanten (nach_ziel) oder ' +
      'den Text in der Zielsprache zurück ins Deutsche (nach_de) — per KI, Verbrauch in ki_verbrauch.',
    bindung: 'beleg',
    modell: 'mail_entwurf',
    schema: z.object({ richtung: z.enum(['nach_ziel', 'nach_de']) }),
    zusammenfassung: (p) => (p.richtung === 'nach_ziel' ? 'Deutsch → Zielsprache' : 'Zielsprache → Deutsch'),
    revalidate: ['/einkauf/entwuerfe/:id'],
  },

  'einkauf.mail_freigeben': {
    label: 'Mail freigeben und senden',
    bereich: 'einkauf',
    beschreibung:
      'Gibt einen Entwurf frei und reiht das Senden über das Einkaufspostfach ein (im bestehenden ' +
      'Thread). Prüft Empfänger, Text in der Versandsprache, offene Platzhalter und die Größe der ' +
      'Anhänge. Nur Menschen geben frei.',
    bindung: 'beleg',
    modell: 'mail_entwurf',
    uebergang: { von: ['entwurf'], nach: ['freigegeben'] },
    schema: z.object({}),
    revalidate: ['/einkauf/entwuerfe/:id', '/einkauf/entwuerfe', '/einkauf/posteingang'],
  },

  'einkauf.mail_verwerfen': {
    label: 'Entwurf verwerfen',
    bereich: 'einkauf',
    beschreibung: 'Verwirft einen nicht gesendeten Entwurf.',
    bindung: 'beleg',
    modell: 'mail_entwurf',
    uebergang: { von: ['entwurf'], nach: ['verworfen'] },
    schema: z.object({}),
    revalidate: ['/einkauf/entwuerfe/:id', '/einkauf/entwuerfe'],
  },

  'einkauf.nachricht_uebersetzen': {
    label: 'Nachricht ins Deutsche übersetzen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Übersetzt eine eingegangene Nachricht (z. B. chinesisch) ins Deutsche und legt die deutsche ' +
      'Fassung neben das Original. Eingehende chinesische Mails werden ohnehin automatisch übersetzt.',
    bindung: 'frei',
    schema: z.object({ nachricht_id: uuid }),
    zusammenfassung: () => 'Nachricht übersetzen',
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
