import { z } from 'zod'
import { FRACHT_MODUS_NAMEN, PROJEKT_ART_NAMEN, staffelnLesen, zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 3 (0097): das Einkaufsprojekt — Bedarf mit Positionen
 * (Zielpreis je Position), Anfragen als Mail-Entwürfe je Lieferant mit
 * Sammelfreigabe, Angebote mit Staffeln, Vergleich in EUR je Stück,
 * Entscheidung, Bestellung; abgeschlossen, sobald alles geliefert ist.
 *
 * Prozessschritte sind nur die Zustandswechsel (anlegen, anfragen,
 * entscheiden, bestellen, abschließen, abbrechen). Alles andere ist Arbeit
 * im Projekt und deshalb prozessfrei: Positionen pflegen, Anfrage-Entwürfe
 * anlegen, Angebote erfassen, Frachtsätze/Zolltarife, EZB-Kurse.
 * Entscheiden, Bestellen und die Sammelfreigabe sind bewusst NICHT `ki` —
 * der Agent (Stufe 6) bereitet vor, ein Mensch entscheidet und sendet.
 */

const uuid = z.string().uuid()
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined
const zahl = (fd: FormData, feld: string, art: 'menge' | 'preis' = 'preis') => {
  const roh = String(fd.get(feld) ?? '').trim()
  if (!roh) return undefined
  return zahlLesen(roh, art) ?? Number.NaN
}
const betrag = z.number({ invalid_type_error: 'Bitte eine Zahl angeben' }).nonnegative('Nicht negativ')

const positionFelder = {
  bezeichnung: z.string().trim().max(200).optional(),
  produkt: z.string().trim().min(1).optional().describe('SKU, Barcode, Name oder ID eines bestehenden Artikels'),
  menge: z.number({ invalid_type_error: 'Bitte eine Menge angeben' }).positive('Die Menge muss größer als 0 sein'),
  zielpreis_eur: betrag.optional().describe('Zielpreis je Stück in EUR (Einstand)'),
  gewicht_g: betrag.optional().describe('Gewicht je Stück in Gramm (für die Frachtschätzung)'),
  hs_code: z.string().trim().max(14).optional(),
  spezifikation: z.string().trim().max(2000).optional(),
}
const bezeichnungOderArtikel = (p: { bezeichnung?: string; produkt?: string }) => Boolean(p.bezeichnung || p.produkt)
const positionSchema = z.object(positionFelder).refine(bezeichnungOderArtikel, 'Bitte Bezeichnung oder Artikel angeben.')

const staffelSchema = z.object({
  position_id: uuid,
  ab_menge: z.number({ invalid_type_error: 'Staffel: Menge unlesbar' }).positive('Staffel: Menge muss größer als 0 sein'),
  preis: z.number({ invalid_type_error: 'Staffel: Preis unlesbar (Format „Menge: Preis")' }).nonnegative(),
})

const angebotsFelder = {
  waehrung: z.string().trim().toUpperCase().length(3, 'Währung als ISO-Code, z. B. USD'),
  incoterm_code: z.string().trim().toUpperCase().max(3).optional(),
  incoterm_ort: z.string().trim().max(120).optional(),
  zahlungsbedingung: z.string().trim().max(200).optional(),
  anzahlung_pct: z.number().min(0).max(100).optional(),
  lieferzeit_tage: z.number().int().min(0).max(730).optional(),
  moq: z.number().positive().optional(),
  werkzeugkosten: betrag.default(0),
  musterkosten: betrag.default(0),
  fracht_modus: z.enum(FRACHT_MODUS_NAMEN).optional(),
  fracht_je_stueck_eur: betrag.optional(),
  gueltig_bis: datum.optional(),
  quell_dokument_id: uuid.optional(),
  quell_nachricht_id: uuid.optional(),
  notiz: z.string().trim().max(4000).optional(),
}

/** Staffeln aus den Textfeldern `staffeln_<position_id>` — unlesbare Zeilen werden NaN und scheitern am Schema. */
function staffelnAusFormular(fd: FormData): { position_id: string; ab_menge: number; preis: number }[] {
  const staffeln: { position_id: string; ab_menge: number; preis: number }[] = []
  for (const [feld, wert] of fd.entries()) {
    if (!feld.startsWith('staffeln_')) continue
    const positionId = feld.slice('staffeln_'.length)
    const { staffeln: gelesen, fehler } = staffelnLesen(String(wert))
    for (const s of gelesen) staffeln.push({ position_id: positionId, ...s })
    if (fehler.length) staffeln.push({ position_id: positionId, ab_menge: 1, preis: Number.NaN })
  }
  return staffeln
}

function angebotAusFormular(fd: FormData) {
  return {
    waehrung: String(fd.get('waehrung') ?? 'EUR'),
    incoterm_code: leer(fd, 'incoterm_code'),
    incoterm_ort: leer(fd, 'incoterm_ort'),
    zahlungsbedingung: leer(fd, 'zahlungsbedingung'),
    anzahlung_pct: zahl(fd, 'anzahlung_pct'),
    lieferzeit_tage: zahl(fd, 'lieferzeit_tage', 'menge'),
    moq: zahl(fd, 'moq', 'menge'),
    werkzeugkosten: zahl(fd, 'werkzeugkosten') ?? 0,
    musterkosten: zahl(fd, 'musterkosten') ?? 0,
    fracht_modus: leer(fd, 'fracht_modus') as never,
    fracht_je_stueck_eur: zahl(fd, 'fracht_je_stueck_eur'),
    gueltig_bis: leer(fd, 'gueltig_bis'),
    quell_dokument_id: leer(fd, 'quell_dokument_id'),
    quell_nachricht_id: leer(fd, 'quell_nachricht_id'),
    notiz: leer(fd, 'notiz'),
    staffeln: staffelnAusFormular(fd),
  }
}

export const EINKAUF_PROJEKTE = {
  'einkauf.projekt_anlegen': {
    label: 'Einkaufsprojekt anlegen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Legt ein Einkaufsprojekt (EP/…) an: Titel, Art (Nachproduktion, Neuteil, Werkzeug, Muster, ' +
      'Betriebsausstattung), Zieltermin, verantwortlicher Einkäufer und Positionen — je Position ' +
      'Bezeichnung oder bestehender Artikel (SKU/Name/ID), Menge, Zielpreis je Stück in EUR, ' +
      'optional Gewicht (g), HS-Code, Spezifikation. Mit muster_pflicht wird erst bestellt, wenn ein ' +
      'Golden Sample des gewählten Lieferanten freigegeben ist.',
    bindung: 'frei',
    modell: 'einkaufsprojekt',
    uebergang: { von: [], nach: ['bedarf'] },
    schema: z.object({
      titel: z.string().trim().min(1, 'Bitte einen Titel angeben').max(200),
      art: z.enum(PROJEKT_ART_NAMEN).default('nachproduktion'),
      beschreibung: z.string().trim().max(4000).optional(),
      verantwortlich_id: uuid.optional(),
      zieltermin: datum.optional(),
      muster_pflicht: z.boolean().default(false).describe('Musterpflicht: bestellt wird erst mit freigegebenem Golden Sample'),
      positionen: z.array(positionSchema).max(50).default([]),
    }),
    zusammenfassung: (p) => `Einkaufsprojekt „${p.titel}" mit ${p.positionen.length} Position(en)`,
    formdata: (fd) => {
      const menge = zahl(fd, 'pos_menge', 'menge')
      const bezeichnung = leer(fd, 'pos_bezeichnung')
      const produkt = leer(fd, 'pos_produkt')
      return {
        titel: String(fd.get('titel') ?? ''),
        art: leer(fd, 'art') as never,
        beschreibung: leer(fd, 'beschreibung'),
        verantwortlich_id: leer(fd, 'verantwortlich_id'),
        zieltermin: leer(fd, 'zieltermin'),
        muster_pflicht: fd.get('muster_pflicht') === 'on',
        positionen:
          bezeichnung || produkt || menge !== undefined
            ? [{ bezeichnung, produkt, menge, zielpreis_eur: zahl(fd, 'pos_zielpreis') }]
            : [],
      }
    },
    revalidate: ['/einkauf/projekte'],
  },

  'einkauf.projekt_aendern': {
    label: 'Projekt bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ändert Titel, Art, Beschreibung, Verantwortlichen, Zieltermin oder die Musterpflicht eines ' +
      'Einkaufsprojekts (Musterpflicht nur bis zur Bestellung).',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z.object({
      titel: z.string().trim().min(1).max(200).optional(),
      art: z.enum(PROJEKT_ART_NAMEN).optional(),
      beschreibung: z.string().trim().max(4000).optional(),
      verantwortlich_id: z.union([uuid, z.literal('')]).optional(),
      zieltermin: z.union([datum, z.literal('')]).optional(),
      muster_pflicht: z.boolean().optional(),
    }),
    zusammenfassung: () => 'Projekt bearbeiten',
    formdata: (fd) => ({
      titel: leer(fd, 'titel'),
      art: leer(fd, 'art') as never,
      beschreibung: fd.has('beschreibung') ? String(fd.get('beschreibung') ?? '') : undefined,
      verantwortlich_id: fd.has('verantwortlich_id') ? String(fd.get('verantwortlich_id') ?? '') : undefined,
      zieltermin: fd.has('zieltermin') ? String(fd.get('zieltermin') ?? '') : undefined,
      // Checkbox: nicht angehakt = nicht gesendet — das Markerfeld sagt, dass sie im Formular stand.
      muster_pflicht: fd.has('muster_pflicht_feld') ? fd.get('muster_pflicht') === 'on' : undefined,
    }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.projekt_position_setzen': {
    label: 'Position setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt eine Position im Einkaufsprojekt an oder ändert sie (mit position_id): Bezeichnung oder ' +
      'Artikel, Menge, Zielpreis je Stück (EUR), Gewicht (g), HS-Code, Spezifikation. Nur bis zur Bestellung.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z
      .object({ position_id: uuid.optional(), ...positionFelder })
      .refine(bezeichnungOderArtikel, 'Bitte Bezeichnung oder Artikel angeben.'),
    zusammenfassung: (p) => `${p.position_id ? 'Position ändern' : 'Position hinzufügen'}: ${p.menge} × ${p.bezeichnung ?? p.produkt}`,
    formdata: (fd) => ({
      position_id: leer(fd, 'position_id'),
      bezeichnung: leer(fd, 'bezeichnung'),
      produkt: leer(fd, 'produkt'),
      menge: zahl(fd, 'menge', 'menge'),
      zielpreis_eur: zahl(fd, 'zielpreis_eur'),
      gewicht_g: zahl(fd, 'gewicht_g'),
      hs_code: leer(fd, 'hs_code'),
      spezifikation: leer(fd, 'spezifikation'),
    }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.projekt_position_entfernen': {
    label: 'Position entfernen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung: 'Entfernt eine Position samt ihrer Angebotsstaffeln (nur bis zur Bestellung).',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z.object({ position_id: uuid }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.anfragen_senden': {
    label: 'Anfragen vorbereiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt für jeden gewählten Lieferanten eine Anfrage und einen Mail-Entwurf in dessen Sprache an ' +
      '(Vorlage „Anfrage", Betreff mit EP-Nummer, Positionen mit Mengen — ohne Zielpreis), mit den ' +
      'gewählten Projektdateien als Anhang und der Frist als „Antwort erwartet bis". Gesendet wird ' +
      'erst mit der Sammelfreigabe.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z.object({
      partner_ids: z.array(uuid).min(1, 'Bitte mindestens einen Lieferanten wählen.').max(20),
      frist: datum.optional(),
      dokument_ids: z.array(uuid).max(20).default([]),
    }),
    zusammenfassung: (p) => `Anfragen an ${p.partner_ids.length} Lieferanten vorbereiten`,
    formdata: (fd) => ({
      partner_ids: fd.getAll('partner_id').map(String).filter(Boolean),
      frist: leer(fd, 'frist'),
      dokument_ids: fd.getAll('dokument_id').map(String).filter(Boolean),
    }),
    revalidate: ['/einkauf/projekte/:id', '/einkauf/entwuerfe'],
  },

  'einkauf.anfragen_freigeben': {
    label: 'Anfragen freigeben und senden',
    bereich: 'einkauf',
    beschreibung:
      'Sammelfreigabe: gibt alle Anfrage-Entwürfe des Projekts frei und reiht das Senden über das ' +
      'Einkaufspostfach ein. Prüft vorher jeden Entwurf (Empfänger, Text in der Versandsprache, offene ' +
      'Platzhalter, Anhanggröße) — scheitert einer, geht keiner hinaus.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    uebergang: { von: ['bedarf', 'angefragt'], nach: ['angefragt'] },
    schema: z.object({}),
    revalidate: ['/einkauf/projekte/:id', '/einkauf/entwuerfe'],
  },

  'einkauf.angebot_erfassen': {
    label: 'Angebot erfassen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Erfasst ein Lieferantenangebot zum Projekt: Lieferant, Währung, Incoterm (+ Ort), Zahlung ' +
      '(Anzahlung %), Lieferzeit (Tage), MOQ, Werkzeug- und Musterkosten (einmalig, Angebotswährung), ' +
      'Frachtmodus oder Fracht je Stück (EUR), gültig bis, Quelle (Dokument oder Nachricht) und je ' +
      'Position die Staffelpreise (ab_menge, preis). Ein weiteres Angebot desselben Lieferanten wird ' +
      'eine neue Version.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z.object({
      partner_id: uuid,
      ...angebotsFelder,
      staffeln: z.array(staffelSchema).min(1, 'Bitte mindestens einen Preis angeben.').max(500),
    }),
    zusammenfassung: (p) => `Angebot in ${p.waehrung} mit ${p.staffeln.length} Staffelpreis(en)`,
    formdata: (fd) => ({ partner_id: String(fd.get('partner_id') ?? ''), ...angebotAusFormular(fd) }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.angebot_aendern': {
    label: 'Angebot ändern',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ändert ein erfasstes Angebot. Staffeln werden je genannter Position ersetzt; Positionen ohne ' +
      'Angabe behalten ihre Preise.',
    bindung: 'frei',
    // partial(): fehlende Felder bleiben, wie sie sind (keine Standardwerte).
    schema: z.object({
      angebot_id: uuid,
      ...z.object(angebotsFelder).partial().shape,
      staffeln: z.array(staffelSchema).max(500).default([]),
    }),
    zusammenfassung: () => 'Angebot ändern',
    formdata: (fd) => ({ angebot_id: String(fd.get('angebot_id') ?? ''), ...angebotAusFormular(fd) }),
    revalidate: ['/einkauf/projekte'],
  },

  'einkauf.angebot_verwerfen': {
    label: 'Angebot verwerfen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung: 'Nimmt ein Angebot aus dem Vergleich (oder holt es mit verworfen=false zurück).',
    bindung: 'frei',
    schema: z.object({ angebot_id: uuid, verworfen: z.boolean().default(true) }),
    formdata: (fd) => ({ angebot_id: String(fd.get('angebot_id') ?? ''), verworfen: fd.get('verworfen') !== 'false' }),
    revalidate: ['/einkauf/projekte'],
  },

  'einkauf.projekt_entscheiden': {
    label: 'Angebot wählen',
    bereich: 'einkauf',
    beschreibung:
      'Entscheidet das Projekt für ein Angebot (mit Begründung). Das Angebot braucht einen Preis für ' +
      'jede Position. Eine spätere Entscheidung ersetzt die frühere, solange nicht bestellt ist.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    uebergang: { von: ['bedarf', 'angefragt', 'entschieden'], nach: ['entschieden'] },
    schema: z.object({ angebot_id: uuid, begruendung: z.string().trim().max(2000).optional() }),
    formdata: (fd) => ({ angebot_id: String(fd.get('angebot_id') ?? ''), begruendung: leer(fd, 'begruendung') }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.projekt_bestellen': {
    label: 'Bestellung anlegen',
    bereich: 'einkauf',
    beschreibung:
      'Legt aus dem gewählten Angebot die Bestellung an (Entwurf): neue Teile bekommen einen Artikel ' +
      '(mit Gewicht und HS-Code), Positionen zum Staffelpreis in Angebotswährung, Werkzeug- und ' +
      'Musterkosten als Dienstleistungszeilen, Incoterm, Zahlplan aus der Anzahlung (Rest bei ' +
      'Verschiffung) und Lieferantenpreise aus den Staffeln; Werkzeugkosten legen das Werkzeug an ' +
      '(in Auftrag). Bestätigt wird die Bestellung in ihrem eigenen Ablauf (Freigabe-Limit). Mit ' +
      'Musterpflicht braucht es ein freigegebenes Golden Sample des gewählten Lieferanten.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    uebergang: { von: ['entschieden'], nach: ['bestellt'] },
    schema: z.object({}),
    revalidate: ['/einkauf/projekte/:id', '/einkauf'],
  },

  'einkauf.projekt_abschliessen': {
    label: 'Projekt abschließen',
    bereich: 'einkauf',
    beschreibung:
      'Schließt ein bestelltes Projekt von Hand ab. Von selbst geschieht das, sobald alle Bestellungen ' +
      'des Projekts vollständig eingegangen (oder storniert) sind.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    uebergang: { von: ['bestellt'], nach: ['abgeschlossen'] },
    schema: z.object({}),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.projekt_abbrechen': {
    label: 'Projekt abbrechen',
    bereich: 'einkauf',
    beschreibung:
      'Bricht ein Projekt mit Grund ab; offene Anfrage-Entwürfe werden verworfen. Ist schon bestellt, ' +
      'müssen die Bestellungen vorher storniert sein.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    uebergang: { von: ['bedarf', 'angefragt', 'entschieden', 'bestellt'], nach: ['abgebrochen'] },
    schema: z.object({ grund: z.string().trim().min(1, 'Bitte einen Grund angeben.').max(1000) }),
    formdata: (fd) => ({ grund: String(fd.get('grund') ?? '') }),
    revalidate: ['/einkauf/projekte/:id', '/einkauf/projekte'],
  },

  'einkauf.bestellung_projekt_zuordnen': {
    label: 'Bestellung zuordnen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Hängt eine bestehende Bestellung an das Einkaufsprojekt (oder löst sie mit loesen=true). Der ' +
      'Projektabschluss zählt ihre Lieferungen mit.',
    bindung: 'beleg',
    modell: 'einkaufsprojekt',
    schema: z.object({ purchase_order_id: uuid, loesen: z.boolean().default(false) }),
    formdata: (fd) => ({
      purchase_order_id: String(fd.get('purchase_order_id') ?? ''),
      loesen: fd.get('loesen') === 'true',
    }),
    revalidate: ['/einkauf/projekte/:id'],
  },

  'einkauf.frachtsatz_setzen': {
    label: 'Frachtsatz setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Setzt den Frachtsatz für die Einstandsschätzung: EUR je kg Bruttogewicht und Mindestbetrag je ' +
      'Sendung, je Modus (See, Luft, Express).',
    bindung: 'frei',
    schema: z.object({
      modus: z.enum(FRACHT_MODUS_NAMEN),
      eur_je_kg: z.number({ invalid_type_error: 'Bitte einen Satz angeben' }).positive('Der Satz muss größer als 0 sein'),
      mindestbetrag_eur: betrag.default(0),
      notiz: z.string().trim().max(300).optional(),
    }),
    zusammenfassung: (p) => `Frachtsatz ${p.modus}: ${p.eur_je_kg} €/kg`,
    formdata: (fd) => ({
      modus: String(fd.get('modus') ?? '') as never,
      eur_je_kg: zahl(fd, 'eur_je_kg'),
      mindestbetrag_eur: zahl(fd, 'mindestbetrag_eur') ?? 0,
      notiz: leer(fd, 'notiz'),
    }),
    revalidate: ['/einkauf/einstand'],
  },

  'einkauf.zolltarif_setzen': {
    label: 'Zollsatz setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Setzt den Zollsatz (%) für einen HS-Präfix (2–10 Ziffern; der längste passende gewinnt) oder ' +
      'entfernt ihn mit loeschen=true. Grundlage der Zollschätzung im Angebotsvergleich.',
    bindung: 'frei',
    schema: z.object({
      hs_praefix: z
        .string()
        .transform((s) => s.replace(/[^0-9]/g, ''))
        .pipe(z.string().regex(/^[0-9]{2,10}$/, 'HS-Präfix: 2 bis 10 Ziffern')),
      satz_pct: z.number({ invalid_type_error: 'Bitte einen Satz angeben' }).min(0).max(100).default(0),
      bezeichnung: z.string().trim().max(200).optional(),
      loeschen: z.boolean().default(false),
    }),
    zusammenfassung: (p) => (p.loeschen ? `Zollsatz ${p.hs_praefix} entfernen` : `Zollsatz ${p.hs_praefix}: ${p.satz_pct} %`),
    formdata: (fd) => ({
      hs_praefix: String(fd.get('hs_praefix') ?? ''),
      satz_pct: zahl(fd, 'satz_pct') ?? 0,
      bezeichnung: leer(fd, 'bezeichnung'),
      loeschen: fd.get('loeschen') === 'true',
    }),
    revalidate: ['/einkauf/einstand'],
  },

  'einkauf.ezb_kurse_abrufen': {
    label: 'EZB-Kurse holen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Holt die aktuellen Referenzkurse der EZB und speichert sie als EUR je Fremdeinheit (Quelle ' +
      '„ezb"). Von Hand erfasste Kurse desselben Tages bleiben stehen. Läuft auch täglich von selbst.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/einkauf/kurse'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
