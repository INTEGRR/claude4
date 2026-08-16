import type { AktionsFn } from './registry/typen.ts'
import type { AktionsName } from './registry/index.ts'
import * as einkauf from './registry/einkauf-ausfuehren.ts'
import * as einstellungen from './registry/einstellungen-ausfuehren.ts'
import * as fehler from './registry/fehler-ausfuehren.ts'
import * as lager from './registry/lager-ausfuehren.ts'
import * as produkte from './registry/produkte-ausfuehren.ts'
import * as reparatur from './registry/reparatur-ausfuehren.ts'
import * as verkauf from './registry/verkauf-ausfuehren.ts'
import * as versand from './registry/versand-ausfuehren.ts'

/**
 * Ausführung je Registry-Aktion.
 *
 * `satisfies Record<AktionsName, …>` ist der Vollständigkeitszwang: eine
 * Aktion ohne Ausführung (oder eine Ausführung ohne Katalogeintrag) bricht
 * den Typecheck — nicht erst den Klick.
 */
export const AUSFUEHRUNG = {
  'einkauf.bestellung_anlegen': einkauf.bestellungAnlegen,
  'einkauf.position_hinzufuegen': einkauf.positionHinzufuegen,
  'einkauf.position_entfernen': einkauf.positionEntfernen,
  'einkauf.kopf_aendern': einkauf.kopfAendern,
  'einkauf.bestaetigen': einkauf.bestaetigen,
  'einkauf.stornieren': einkauf.stornieren,
  'einkauf.sperren': einkauf.sperren,
  'einkauf.email_senden': einkauf.emailSenden,
  'einkauf.rechnung_erstellen': einkauf.rechnungErstellen,
  'einkauf.rechnung_details': einkauf.rechnungDetails,
  'einkauf.rechnung_pruefen': einkauf.rechnungPruefen,
  'einkauf.rechnung_buchen': einkauf.rechnungBuchen,
  'einkauf.rechnung_zahlen': einkauf.rechnungZahlen,
  'einkauf.rechnung_stornieren': einkauf.rechnungStornieren,
  'einkauf.nebenkosten_erfassen': einkauf.nebenkostenErfassen,
  'einkauf.nebenkosten_buchen': einkauf.nebenkostenBuchen,
  'einkauf.nebenkosten_stornieren': einkauf.nebenkostenStornieren,
  'einkauf.wechselkurs_erfassen': einkauf.wechselkursErfassen,

  'einstellungen.prozessschritt_schalten': einstellungen.prozessschrittSchalten,

  'fehler.ticket_melden': fehler.ticketMelden,
  'fehler.ticket_status': fehler.ticketStatus,

  'lager.transfer_buchen': lager.transferBuchen,
  'lager.transfer_bestaetigen': lager.transferBestaetigen,
  'lager.verfuegbarkeit_pruefen': lager.verfuegbarkeitPruefen,
  'lager.transfer_stornieren': lager.transferStornieren,
  'lager.transfer_retoure': lager.transferRetoure,
  'lager.transfer_details': lager.transferDetails,
  'lager.zaehlung_erfassen': lager.zaehlungErfassen,
  'lager.zaehlung_buchen': lager.zaehlungBuchen,
  'lager.zaehlung_loeschen': lager.zaehlungLoeschen,
  'lager.ausschuss_buchen': lager.ausschussBuchen,
  'lager.meldebestand_anlegen': lager.meldebestandAnlegen,
  'lager.meldebestand_loeschen': lager.meldebestandLoeschen,
  'lager.meldebestand_schlummern': lager.meldebestandSchlummern,
  'lager.meldebestand_wecken': lager.meldebestandWecken,
  'lager.beschaffung_ausfuehren': lager.beschaffungAusfuehren,
  'lager.eroeffnungsbewertung': lager.eroeffnungsbewertung,

  'produkte.produkt_anlegen': produkte.produktAnlegenAktion,

  'reparatur.auftrag_anlegen': reparatur.auftragAnlegen,
  'reparatur.teil_hinzufuegen': reparatur.teilHinzufuegen,
  'reparatur.teil_entfernen': reparatur.teilEntfernen,
  'reparatur.bestaetigen': reparatur.bestaetigen,
  'reparatur.beginnen': reparatur.beginnen,
  'reparatur.abschliessen': reparatur.abschliessen,
  'reparatur.stornieren': reparatur.stornieren,
  'reparatur.angebot_erstellen': reparatur.angebotErstellen,
  'reparatur.details': reparatur.details,

  'verkauf.auftrag_anlegen': verkauf.auftragAnlegen,
  'verkauf.bestaetigen': verkauf.bestaetigen,
  'verkauf.stornieren': verkauf.stornieren,
  'verkauf.zurueck_auf_angebot': verkauf.zurueckAufAngebot,
  'verkauf.kopf_aendern': verkauf.kopfAendern,
  'verkauf.sperren': verkauf.sperren,
  'verkauf.position_hinzufuegen': verkauf.positionHinzufuegen,
  'verkauf.position_entfernen': verkauf.positionEntfernen,

  'versand.label_erstellen': versand.labelErstellen,
  'versand.label_stornieren': versand.labelStornieren,
  'versand.tracking_aktualisieren': versand.trackingAktualisieren,
  'versand.massendruck': versand.massendruck,
  'versand.retourenlabel_erstellen': versand.retourenlabelErstellen,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<AktionsName, AktionsFn<any>>
