import type { AktionsFn } from './registry/typen.ts'
import type { AktionsName } from './registry/index.ts'
import * as fehler from './registry/fehler-ausfuehren.ts'
import * as lager from './registry/lager-ausfuehren.ts'
import * as reparatur from './registry/reparatur-ausfuehren.ts'

/**
 * Ausführung je Registry-Aktion.
 *
 * `satisfies Record<AktionsName, …>` ist der Vollständigkeitszwang: eine
 * Aktion ohne Ausführung (oder eine Ausführung ohne Katalogeintrag) bricht
 * den Typecheck — nicht erst den Klick.
 */
export const AUSFUEHRUNG = {
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

  'reparatur.auftrag_anlegen': reparatur.auftragAnlegen,
  'reparatur.teil_hinzufuegen': reparatur.teilHinzufuegen,
  'reparatur.teil_entfernen': reparatur.teilEntfernen,
  'reparatur.bestaetigen': reparatur.bestaetigen,
  'reparatur.beginnen': reparatur.beginnen,
  'reparatur.abschliessen': reparatur.abschliessen,
  'reparatur.stornieren': reparatur.stornieren,
  'reparatur.angebot_erstellen': reparatur.angebotErstellen,
  'reparatur.details': reparatur.details,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<AktionsName, AktionsFn<any>>
