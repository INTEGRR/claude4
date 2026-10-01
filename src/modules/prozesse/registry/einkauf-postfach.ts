import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 2a (0093): das Einkaufspostfach. Gelesen wird per Cron
 * (einkauf/postfach-abgleich.ts), zugeordnet zuerst per SQL-Regel
 * (`mail_thread_zuordnen`) — diese Aktionen sind die menschliche Seite:
 * zuordnen (gewinnt immer gegen die Regel), Status setzen, Alibaba-Chats
 * und Telefonate erfassen, Wiedervorlagen. Alle prozessfrei: ein Thread
 * ist Kommunikation am Beleg, kein eigener Ablauf (Entscheidungslog
 * 2026-09-30).
 */

const uuid = z.string().uuid()

/** Woran eine Wiedervorlage hängen darf (Teilmenge der Dokument-Belege). */
export const WIEDERVORLAGE_MODELLE = [
  'mail_thread',
  'partner',
  'purchase_order',
  'vendor_bill',
  'einkaufsprojekt',
  'bemusterung',
  'werkzeug',
  'lieferantenvertrag',
] as const
export type WiedervorlageModell = (typeof WIEDERVORLAGE_MODELLE)[number]

const leerAlsUndefined = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined

export const EINKAUF_POSTFACH = {
  'einkauf.mail_zuordnen': {
    label: 'Thread zuordnen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ordnet einen Mail-Thread einem Lieferanten, einer Bestellung und/oder einem Einkaufsprojekt zu und setzt den ' +
      'zuständigen Einkäufer. Gewinnt immer gegen die automatische Regel. Die Anhänge des Threads ' +
      'werden mit Lieferant und Bestellung verknüpft und ziehen in deren Drive-Ordner um. Auf ' +
      'Wunsch merkt sich die Lieferantenakte den Absender (Domain, bei Freemailern die Adresse), ' +
      'damit künftige Mails von selbst zugeordnet werden.',
    bindung: 'beleg',
    modell: 'mail_thread',
    schema: z
      .object({
        partner_id: uuid.optional(),
        purchase_order_id: uuid.optional(),
        einkaufsprojekt_id: uuid.optional(),
        zustaendig_id: uuid.optional(),
        absender_merken: z.boolean().default(false),
      })
      .refine(
        (p) => p.partner_id || p.purchase_order_id || p.einkaufsprojekt_id,
        'Bitte Lieferant, Bestellung oder Einkaufsprojekt wählen.',
      ),
    zusammenfassung: (p) =>
      ['Thread zuordnen', p.purchase_order_id && 'Bestellung', p.einkaufsprojekt_id && 'Einkaufsprojekt', p.partner_id && 'Lieferant', p.absender_merken && 'Absender merken']
        .filter(Boolean)
        .join(' · '),
    formdata: (fd) => ({
      partner_id: leerAlsUndefined(fd, 'partner_id'),
      purchase_order_id: leerAlsUndefined(fd, 'purchase_order_id'),
      einkaufsprojekt_id: leerAlsUndefined(fd, 'einkaufsprojekt_id'),
      zustaendig_id: leerAlsUndefined(fd, 'zustaendig_id'),
      absender_merken: fd.get('absender_merken') === 'on' || fd.get('absender_merken') === 'true',
    }),
    revalidate: ['/einkauf/posteingang/:id', '/einkauf/posteingang'],
  },

  'einkauf.mail_status_setzen': {
    label: 'Thread-Status setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Setzt einen Mail-Thread auf offen, erledigt oder ignoriert (Newsletter, Spam). Eine neue ' +
      'Antwort des Lieferanten holt einen erledigten Thread von selbst zurück in den Posteingang.',
    bindung: 'beleg',
    modell: 'mail_thread',
    schema: z.object({ status: z.enum(['offen', 'erledigt', 'ignoriert']) }),
    zusammenfassung: (p) => `Thread ${p.status}`,
    formdata: (fd) => ({ status: String(fd.get('status') ?? '') as never }),
    revalidate: ['/einkauf/posteingang/:id', '/einkauf/posteingang'],
  },

  'einkauf.nachricht_erfassen': {
    label: 'Nachricht erfassen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Erfasst eine Nachricht von Hand — Alibaba-Chat, Telefonat, WeChat o. Ä. — in einem ' +
      'bestehenden Thread oder als neuen Thread am Lieferanten. Screenshots hängen danach als ' +
      'Dokument am Thread.',
    bindung: 'frei',
    schema: z
      .object({
        kanal: z.enum(['alibaba', 'telefon', 'sonstiges', 'email']),
        richtung: z.enum(['eingang', 'ausgang']),
        thread_id: uuid.optional(),
        partner_id: uuid.optional(),
        purchase_order_id: uuid.optional(),
        betreff: z.string().trim().max(300).optional(),
        text: z.string().trim().min(1, 'Bitte den Inhalt der Nachricht eintragen.').max(50_000),
        datum: z.string().datetime({ local: true, offset: true }).optional(),
      })
      .refine((p) => p.thread_id || p.partner_id || p.purchase_order_id, 'Bitte Thread, Lieferant oder Bestellung angeben.'),
    zusammenfassung: (p) => `${p.kanal === 'alibaba' ? 'Alibaba-Nachricht' : p.kanal === 'telefon' ? 'Telefonat' : 'Nachricht'} erfassen`,
    formdata: (fd) => ({
      kanal: String(fd.get('kanal') ?? 'alibaba') as never,
      richtung: String(fd.get('richtung') ?? 'eingang') as never,
      thread_id: leerAlsUndefined(fd, 'thread_id'),
      partner_id: leerAlsUndefined(fd, 'partner_id'),
      purchase_order_id: leerAlsUndefined(fd, 'purchase_order_id'),
      betreff: leerAlsUndefined(fd, 'betreff'),
      text: String(fd.get('text') ?? ''),
      datum: leerAlsUndefined(fd, 'datum'),
    }),
    revalidate: ['/einkauf/posteingang', '/einkauf/posteingang/:ergebnis'],
  },

  'einkauf.wiedervorlage_anlegen': {
    label: 'Wiedervorlage anlegen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt eine Wiedervorlage an einen Thread, Lieferanten, eine Bestellung oder Rechnung — ' +
      '„Antwort erwartet bis", „Liefertermin prüfen", „PI anfordern". Erscheint in der ' +
      'Wiedervorlagen-Liste des Zuständigen.',
    bindung: 'frei',
    schema: z.object({
      modell: z.enum(WIEDERVORLAGE_MODELLE),
      record_id: uuid,
      faellig_am: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT'),
      grund: z.string().trim().min(1, 'Bitte einen Grund angeben.').max(300),
      zustaendig_id: uuid.optional(),
    }),
    zusammenfassung: (p) => `Wiedervorlage ${p.faellig_am}: ${p.grund}`,
    formdata: (fd) => ({
      modell: String(fd.get('modell') ?? '') as never,
      record_id: String(fd.get('record_id') ?? ''),
      faellig_am: String(fd.get('faellig_am') ?? ''),
      grund: String(fd.get('grund') ?? ''),
      zustaendig_id: leerAlsUndefined(fd, 'zustaendig_id'),
    }),
    revalidate: ['/einkauf/wiedervorlagen'],
  },

  'einkauf.wiedervorlage_erledigen': {
    label: 'Wiedervorlage erledigen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung: 'Hakt eine Wiedervorlage ab.',
    bindung: 'frei',
    schema: z.object({ wiedervorlage_id: uuid }),
    formdata: (fd) => ({ wiedervorlage_id: String(fd.get('wiedervorlage_id') ?? '') }),
    revalidate: ['/einkauf/wiedervorlagen'],
  },

  'integrationen.postfach_abgleichen': {
    label: 'Einkaufspostfach jetzt abgleichen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Holt neue Mails aus dem Einkaufspostfach sofort statt beim nächsten Minutenlauf — ' +
      'z. B. nach der Einrichtung oder um den Abgleich zu prüfen.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/einkauf/posteingang', '/einstellungen/anbindungen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
