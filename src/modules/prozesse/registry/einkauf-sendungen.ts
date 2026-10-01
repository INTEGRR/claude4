import { z } from 'zod'
import { zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import { PFLICHT_MODELLE } from '../../einkauf/pflichtdokumente.ts'
import { KOSTEN_ART_NAMEN, SENDUNG_MODUS_NAMEN, bestellnummernLesen, zollzeilenLesen } from '../../einkauf/sendungen.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 5 (0108): Eingangssendungen (Sammelfracht) mit eigenem
 * Prozess `eingangs_sendung` — anlegen → verschiffen (die Zahlplan-Raten
 * „bei Verschiffung" werden fällig) → verzollen → ankommen → Teilprozess
 * Wareneingang → abrechnen (Kosten als Landed Costs verteilt) | stornieren.
 * Prozessschritte sind nur die Zustandswechsel; Daten pflegen, Bestellungen
 * zuordnen, Kosten und Zollbescheid erfassen, schätzen und verteilen ist
 * Arbeit an der Sendung und prozessfrei. Dazu die Nachfrage fehlender
 * Pflichtdokumente (nur ein Mail-Entwurf) und das Übernehmen gelernter
 * Fracht- und Zollsätze.
 *
 * Bewertungswirksames (abrechnen, verteilen, stornieren, Kosten entfernen)
 * ist bewusst NICHT `ki` — der Agent bereitet vor, gebucht wird von
 * Menschen.
 */

const uuid = z.string().uuid()
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined
const zahl = (fd: FormData, feld: string, art: 'menge' | 'preis' = 'preis') => {
  const roh = String(fd.get(feld) ?? '').trim()
  if (!roh) return undefined
  return zahlLesen(roh, art) ?? Number.NaN
}
const nichtNegativ = z.number({ invalid_type_error: 'Bitte eine Zahl angeben' }).nonnegative('Nicht negativ')

const kopfFelder = {
  bezeichnung: z.string().trim().max(200).optional().describe('Kurzbezeichnung, z. B. „LCL Shenzhen KW 41"'),
  modus: z.enum(SENDUNG_MODUS_NAMEN).optional().describe('see | luft | express'),
  spediteur_id: uuid.optional().describe('Spediteur bzw. Kurier als Lieferant (schickt die Frachtrechnung)'),
  traeger: z.string().trim().max(120).optional().describe('Reederei, Airline oder Kurierdienst'),
  hbl_awb: z.string().trim().max(80).optional().describe('House Bill of Lading bzw. Air Waybill'),
  container: z.string().trim().max(80).optional(),
  tracking_url: z.string().trim().url('Bitte einen vollständigen Link (https://…)').max(500).optional(),
  etd: datum.optional().describe('Geplanter Abgang'),
  eta: datum.optional().describe('Erwartete Ankunft'),
  gewicht_kg: nichtNegativ.optional().describe('Bruttogewicht kg (Grundlage der Frachtschätzung)'),
  volumen_cbm: nichtNegativ.optional(),
  packstuecke: z.number().int('Packstücke als ganze Zahl').nonnegative().optional(),
  zustaendig_id: uuid.optional(),
  notiz: z.string().trim().max(2000).optional(),
}

const kopfAusFormular = (fd: FormData) => ({
  bezeichnung: leer(fd, 'bezeichnung'),
  modus: leer(fd, 'modus') as never,
  spediteur_id: leer(fd, 'spediteur_id'),
  traeger: leer(fd, 'traeger'),
  hbl_awb: leer(fd, 'hbl_awb'),
  container: leer(fd, 'container'),
  tracking_url: leer(fd, 'tracking_url'),
  etd: leer(fd, 'etd'),
  eta: leer(fd, 'eta'),
  gewicht_kg: zahl(fd, 'gewicht_kg', 'menge'),
  volumen_cbm: zahl(fd, 'volumen_cbm', 'menge'),
  packstuecke: zahl(fd, 'packstuecke', 'menge'),
  zustaendig_id: leer(fd, 'zustaendig_id'),
  notiz: leer(fd, 'notiz'),
})

const bestellungenFeld = z
  .array(z.string().trim().min(1))
  .max(50)
  .describe('Bestellungen: Nummern (P00042) oder IDs')

export const EINKAUF_SENDUNGEN = {
  'einkauf.sendung_anlegen': {
    label: 'Eingangssendung anlegen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Legt eine Eingangssendung (ES/…) an — Sammelfracht mit einer oder mehreren bestätigten Bestellungen: ' +
      'Modus (See, Luft, Express), Spediteur, Träger, HBL/AWB, Container, ETD/ETA, kg, cbm, Packstücke. ' +
      'Die Wareneingänge der Bestellungen hängen danach an der Sendung.',
    bindung: 'frei',
    modell: 'eingangs_sendung',
    uebergang: { von: [], nach: ['geplant'] },
    schema: z.object({ ...kopfFelder, bestellungen: bestellungenFeld.default([]) }),
    zusammenfassung: (p) =>
      `Eingangssendung anlegen${p.modus ? ` (${p.modus})` : ''}${p.bestellungen.length ? ` mit ${p.bestellungen.join(', ')}` : ''}`,
    formdata: (fd) => ({
      ...kopfAusFormular(fd),
      bestellungen: [...fd.getAll('bestellung').map(String).filter(Boolean), ...bestellnummernLesen(String(fd.get('bestellnummern') ?? ''))],
    }),
    revalidate: ['/einkauf/sendungen'],
  },

  'einkauf.sendung_aendern': {
    label: 'Eingangssendung bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Trägt Daten einer Eingangssendung nach (Spediteur, Träger, HBL/AWB, Container, Tracking-Link, ETD/ETA, kg, cbm, ' +
      'Packstücke, Zuständig, Notiz). ETA und Tracking wandern auf die Bestellungen der Sendung.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({ ...kopfFelder, verschifft_am: datum.optional(), verzollt_am: datum.optional(), angekommen_am: datum.optional() }),
    zusammenfassung: (p) => `Eingangssendung bearbeiten${p.eta ? ` (ETA ${p.eta})` : ''}`,
    formdata: (fd) => ({
      ...kopfAusFormular(fd),
      verschifft_am: leer(fd, 'verschifft_am'),
      verzollt_am: leer(fd, 'verzollt_am'),
      angekommen_am: leer(fd, 'angekommen_am'),
    }),
    revalidate: ['/einkauf/sendungen/:id', '/einkauf/sendungen'],
  },

  'einkauf.sendung_bestellung_zuordnen': {
    label: 'Bestellung in die Sendung nehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Nimmt bestätigte Bestellungen in die Eingangssendung auf (Sammelfracht). Ihre Wareneingänge, die noch keiner ' +
      'anderen Sendung gehören, hängen danach an dieser; ist die Sendung schon verschifft, gilt das auch für die Bestellung.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({ bestellungen: bestellungenFeld.min(1, 'Bitte mindestens eine Bestellung angeben') }),
    zusammenfassung: (p) => `In die Sendung: ${p.bestellungen.join(', ')}`,
    formdata: (fd) => ({
      bestellungen: [...fd.getAll('bestellung').map(String).filter(Boolean), ...bestellnummernLesen(String(fd.get('bestellnummern') ?? ''))],
    }),
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.sendung_bestellung_loesen': {
    label: 'Bestellung aus der Sendung nehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Nimmt eine Bestellung wieder aus der Eingangssendung (nur solange keiner ihrer Wareneingänge dieser Sendung gebucht ist).',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({ purchase_order_id: uuid }),
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.sendung_verschiffen': {
    label: 'Verschifft',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Meldet die Sendung als verschifft (Datum ohne Angabe heute; optional ETD, ETA, HBL/AWB, Container). Der Tag geht ' +
      'als verschifft_am an alle Bestellungen der Sendung — Zahlplan-Raten „bei Verschiffung" werden damit fällig.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    uebergang: { von: ['geplant'], nach: ['verschifft'] },
    schema: z.object({
      verschifft_am: datum.optional(),
      etd: datum.optional(),
      eta: datum.optional(),
      hbl_awb: kopfFelder.hbl_awb,
      container: kopfFelder.container,
    }),
    zusammenfassung: (p) => `Sendung verschifft${p.verschifft_am ? ` am ${p.verschifft_am}` : ''}${p.eta ? `, ETA ${p.eta}` : ''}`,
    formdata: (fd) => ({
      verschifft_am: leer(fd, 'verschifft_am'),
      etd: leer(fd, 'etd'),
      eta: leer(fd, 'eta'),
      hbl_awb: leer(fd, 'hbl_awb'),
      container: leer(fd, 'container'),
    }),
    revalidate: ['/einkauf/sendungen/:id', '/einkauf/sendungen', '/finanzen'],
  },

  'einkauf.sendung_verzollen': {
    label: 'Verzollt',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Meldet die Sendung als verzollt (Datum ohne Angabe heute). Den Zollbescheid erfasst „Zollbescheid erfassen".',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    uebergang: { von: ['verschifft'], nach: ['verzollt'] },
    schema: z.object({ verzollt_am: datum.optional() }),
    zusammenfassung: (p) => `Sendung verzollt${p.verzollt_am ? ` am ${p.verzollt_am}` : ''}`,
    formdata: (fd) => ({ verzollt_am: leer(fd, 'verzollt_am') }),
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.sendung_ankommen': {
    label: 'Angekommen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Meldet die Sendung als bei uns angekommen (Datum ohne Angabe heute) — danach werden die Wareneingänge gebucht. ' +
      'Express-Sendungen (Kurier verzollt selbst) kommen direkt aus „verschifft".',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    uebergang: { von: ['verschifft', 'verzollt'], nach: ['angekommen'] },
    schema: z.object({ angekommen_am: datum.optional() }),
    zusammenfassung: (p) => `Sendung angekommen${p.angekommen_am ? ` am ${p.angekommen_am}` : ''}`,
    formdata: (fd) => ({ angekommen_am: leer(fd, 'angekommen_am') }),
    revalidate: ['/einkauf/sendungen/:id', '/einkauf/sendungen'],
  },

  'einkauf.sendung_abrechnen': {
    label: 'Sendung abrechnen',
    bereich: 'einkauf',
    beschreibung:
      'Schließt die Sendung ab: alle Wareneingänge gebucht, keine Schätzung mehr offen; die noch nicht verteilten Kosten ' +
      '(Fracht, Zoll, Versicherung, Sonstiges — nie die EUSt) gehen als Landed Costs anteilig auf die Wareneingänge.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    uebergang: { von: ['angekommen'], nach: ['abgerechnet'] },
    schema: z.object({}),
    revalidate: ['/einkauf/sendungen/:id', '/einkauf/sendungen', '/lager/bewertung'],
  },

  'einkauf.sendung_stornieren': {
    label: 'Sendung stornieren',
    bereich: 'einkauf',
    beschreibung:
      'Storniert eine geplante oder verschiffte Sendung (Grund Pflicht) — nur ohne gebuchten Wareneingang und ohne ' +
      'verteilte Kosten. Die Wareneingänge lösen sich, ein nur von ihr gesetzter Verschiffungstag wird zurückgenommen.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    uebergang: { von: ['geplant', 'verschifft'], nach: ['storniert'] },
    schema: z.object({ grund: z.string().trim().min(3, 'Bitte einen Grund angeben').max(500) }),
    zusammenfassung: (p) => `Sendung stornieren: ${p.grund}`,
    formdata: (fd) => ({ grund: String(fd.get('grund') ?? '') }),
    revalidate: ['/einkauf/sendungen/:id', '/einkauf/sendungen'],
  },

  'einkauf.sendung_kosten_erfassen': {
    label: 'Sendungskosten erfassen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Erfasst eine Kostenposition der Sendung: Fracht, Zoll, EUSt, Versicherung oder Sonstiges, Betrag und Währung, ' +
      'als Schätzung oder als Rechnung (Lieferantenrechnung, Dokument, Rechnungssteller). Eine Rechnung ersetzt die ' +
      'offenen Schätzungen derselben Art — beim Verteilen wird die Differenz als Korrektur gebucht. EUSt wird nie verteilt.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({
      art: z.enum(KOSTEN_ART_NAMEN),
      betrag: nichtNegativ,
      waehrung: z.string().trim().toUpperCase().length(3, 'Währung als ISO-Code, z. B. USD').default('EUR'),
      belegdatum: datum.optional(),
      schaetzung: z.boolean().default(false),
      partner_id: uuid.optional().describe('Rechnungssteller (Spediteur, Zoll, Versicherer)'),
      vendor_bill_id: uuid.optional(),
      dokument_id: uuid.optional(),
      notiz: z.string().trim().max(500).optional(),
    }),
    zusammenfassung: (p) => `${p.schaetzung ? 'Schätzung' : 'Kosten'} ${p.art}: ${p.betrag} ${p.waehrung}`,
    formdata: (fd) => ({
      art: String(fd.get('art') ?? '') as never,
      betrag: zahl(fd, 'betrag') ?? Number.NaN,
      waehrung: leer(fd, 'waehrung'),
      belegdatum: leer(fd, 'belegdatum'),
      schaetzung: fd.get('schaetzung') === 'on',
      partner_id: leer(fd, 'partner_id'),
      vendor_bill_id: leer(fd, 'vendor_bill_id'),
      dokument_id: leer(fd, 'dokument_id'),
      notiz: leer(fd, 'notiz'),
    }),
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.sendung_kosten_entfernen': {
    label: 'Kostenposition stornieren',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Storniert eine Kostenposition der Sendung; schon gebuchte Landed Costs werden zurückgenommen. Von ihr ersetzte ' +
      'Schätzungen gelten wieder.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({ kosten_id: uuid }),
    revalidate: ['/einkauf/sendungen/:id', '/lager/bewertung'],
  },

  'einkauf.sendung_verteilen': {
    label: 'Kosten verteilen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Verteilt die noch nicht verteilten Kosten (ohne EUSt) anteilig auf die gebuchten Wareneingänge der Sendung — je ' +
      'Eingang ein Landed-Cost-Beleg; Fracht nach Gewicht (wenn jede Position eines hat), sonst nach Warenwert. Geht ' +
      'auch mit Schätzungen; kommt die Rechnung, wird korrigiert.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({}),
    revalidate: ['/einkauf/sendungen/:id', '/lager/bewertung'],
  },

  'einkauf.sendung_schaetzen': {
    label: 'Fracht und Zoll schätzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt Schätzungen für Fracht (kg × Frachtsatz des Modus, mindestens Mindestbetrag) und Zoll (Warenwert × Zollsatz ' +
      'je HS-Präfix) an — nur für Arten, zu denen es noch keine Kostenposition gibt.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z.object({}),
    zusammenfassung: () => 'Fracht und Zoll schätzen',
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.sendung_zoll_erfassen': {
    label: 'Zollbescheid erfassen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Erfasst den Zollbescheid der Sendung: je HS-Code Zollwert, Zoll und EUSt (eine Zeile „HS; Zollwert; Zoll; EUSt"). ' +
      'Daraus entstehen die Kostenpositionen Zoll (wird verteilt) und EUSt (nie verteilt); ein neuer Bescheid ersetzt den ' +
      'alten, Zoll-Schätzungen werden ersetzt.',
    bindung: 'beleg',
    modell: 'eingangs_sendung',
    schema: z
      .object({
        zeilen: z
          .array(
            z.object({
              hs_code: z.string().trim().regex(/^\d{4,10}$/, 'HS-Code mit 4–10 Ziffern'),
              zollwert_eur: nichtNegativ,
              zoll_eur: nichtNegativ,
              eust_eur: nichtNegativ.default(0),
              purchase_order_id: uuid.optional(),
              ursprungsland: z.string().trim().length(2).optional(),
            }),
          )
          .max(100),
        belegdatum: datum.optional(),
        partner_id: uuid.optional().describe('Wer die Abgaben in Rechnung stellt (Spediteur/Zoll)'),
        dokument_id: uuid.optional(),
        // Nur vom Formular-Adapter: unlesbare Zeilen fallen nicht still weg.
        lesefehler: z.array(z.string()).default([]),
      })
      .superRefine((p, ctx) => {
        for (const f of p.lesefehler) ctx.addIssue({ code: z.ZodIssueCode.custom, message: f, path: ['zeilen'] })
        if (p.zeilen.length === 0 && p.lesefehler.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Bitte mindestens eine Zollzeile angeben', path: ['zeilen'] })
        }
      }),
    zusammenfassung: (p) =>
      `Zollbescheid: ${p.zeilen.length} Zeile(n), Zoll ${p.zeilen.reduce((s: number, z: { zoll_eur: number }) => s + z.zoll_eur, 0).toFixed(2)} €, ` +
      `EUSt ${p.zeilen.reduce((s: number, z: { eust_eur: number }) => s + z.eust_eur, 0).toFixed(2)} €`,
    formdata: (fd) => {
      const { zeilen, fehler } = zollzeilenLesen(String(fd.get('zeilen') ?? ''))
      return {
        zeilen,
        lesefehler: fehler,
        belegdatum: leer(fd, 'belegdatum'),
        partner_id: leer(fd, 'partner_id'),
        dokument_id: leer(fd, 'dokument_id'),
      }
    },
    revalidate: ['/einkauf/sendungen/:id'],
  },

  'einkauf.pflichtdokumente_nachfragen': {
    label: 'Fehlende Dokumente nachfragen',
    bereich: 'einkauf',
    // Arbeit am Beleg, kein Zustandswechsel: legt nur einen Mail-Entwurf an,
    // gesendet wird erst nach Freigabe im Prozess mail_versand.
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt für eine Bestellung (an den Lieferanten) oder eine Eingangssendung (an den Spediteur) einen Mail-Entwurf ' +
      'aus der Vorlage „Fehlende Dokumente nachfragen" in dessen Sprache an — mit allen fehlenden Pflichtdokumenten. ' +
      'Gesendet wird erst nach Freigabe durch einen Menschen.',
    bindung: 'frei',
    schema: z.object({
      modell: z.enum(PFLICHT_MODELLE),
      record_id: uuid,
      antwort_erwartet_bis: datum.optional(),
    }),
    zusammenfassung: (p) => `Fehlende Dokumente nachfragen (${p.modell === 'purchase_order' ? 'Bestellung' : 'Sendung'})`,
    formdata: (fd) => ({
      modell: String(fd.get('modell') ?? '') as never,
      record_id: String(fd.get('record_id') ?? ''),
      antwort_erwartet_bis: leer(fd, 'antwort_erwartet_bis'),
    }),
    revalidate: ['/einkauf/entwuerfe', '/einkauf/cockpit'],
  },

  'einkauf.einstand_vorschlag_uebernehmen': {
    label: 'Gelernten Satz übernehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Übernimmt einen Vorschlag aus abgerechneten Sendungen in die Einstandssätze: Fracht EUR/kg je Modus bzw. ' +
      'Zollsatz je HS-Präfix. Der Wert kommt aus der Sicht einkauf_einstand_vorschlaege, nicht aus der Eingabe.',
    bindung: 'frei',
    schema: z.object({
      art: z.enum(['fracht', 'zoll']),
      schluessel: z.string().trim().min(2).max(10).describe('Modus (see|luft|express) bzw. HS-Präfix'),
    }),
    zusammenfassung: (p) => `${p.art === 'fracht' ? 'Frachtsatz' : 'Zollsatz'} ${p.schluessel} aus Sendungen übernehmen`,
    formdata: (fd) => ({ art: String(fd.get('art') ?? '') as never, schluessel: String(fd.get('schluessel') ?? '') }),
    revalidate: ['/einkauf/einstand'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
