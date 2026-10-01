import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aufgaben für Mitarbeiter (0104): „feg mal bitte hinten das Lager durch",
 * „bereite die Gehäuse für Montag vor" — mit Termin, an eine Person oder
 * ein Team, sichtbar in deren Übersicht. Prozessfrei wie die
 * Wiedervorlagen: eine Aufgabe ist ein Zettel mit Haken, kein Ablauf
 * (Entscheidungslog 2026-10-01, „Aufgaben für Mitarbeiter").
 *
 * Zuständig und Termin kommen als Text — so spricht man sie („Tino",
 * „das Lager", „morgen", „15 Uhr"); aufgelöst wird in der Ausführung.
 */

const uuid = z.string().uuid()
const leerAlsUndefined = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined

export const AUFGABEN = {
  'aufgaben.anlegen': {
    label: 'Aufgabe anlegen',
    bereich: 'aufgaben',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Gibt einem Mitarbeiter oder einem Team eine Aufgabe mit Termin („Lager durchfegen, heute 15 Uhr, Tino"). ' +
      'titel = was zu tun ist; zustaendig = Vorname, Name oder Benutzername der Person ODER ein Team ' +
      '(Lager, Fertigung, Büro) — leer = für mich selbst; faellig_am = heute, morgen, übermorgen, ein ' +
      'Wochentag oder ein Datum (TT.MM.JJJJ), leer = heute; uhrzeit = z. B. 15:00, leer = im Laufe des ' +
      'Tages; dauer_min = geschätzte Dauer in Minuten. Die Aufgabe erscheint beim Zuständigen in der Übersicht.',
    bindung: 'frei',
    schema: z.object({
      titel: z.string().trim().min(1, 'Bitte angeben, was zu tun ist.').max(200),
      beschreibung: z.string().trim().max(2000).optional(),
      zustaendig: z.string().trim().max(120).optional(),
      faellig_am: z.string().trim().max(40).default('heute'),
      uhrzeit: z.string().trim().max(12).optional(),
      // coerce: die Stimme schickt Zahlen gern als Text („30").
      dauer_min: z.coerce.number().int().min(1, 'Dauer in Minuten, mindestens 1').max(1440).optional(),
    }),
    zusammenfassung: (p) =>
      `Aufgabe${p.zustaendig ? ` für ${p.zustaendig}` : ''}: ${p.titel} (${p.faellig_am}${p.uhrzeit ? `, ${p.uhrzeit}` : ''})`,
    formdata: (fd) => {
      const dauer = leerAlsUndefined(fd, 'dauer_min')
      return {
        titel: String(fd.get('titel') ?? ''),
        beschreibung: leerAlsUndefined(fd, 'beschreibung'),
        zustaendig: leerAlsUndefined(fd, 'zustaendig'),
        faellig_am: leerAlsUndefined(fd, 'faellig_am'),
        uhrzeit: leerAlsUndefined(fd, 'uhrzeit'),
        dauer_min: dauer === undefined ? undefined : Number(dauer),
      }
    },
    revalidate: ['/aufgaben', '/'],
  },

  'aufgaben.erledigen': {
    label: 'Aufgabe erledigt',
    bereich: 'aufgaben',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Hakt eine Aufgabe ab — optional mit kurzer Rückmeldung (notiz). aufgabe = ID oder ein Stichwort ' +
      'aus dem Titel einer meiner offenen Aufgaben („fegen"). Erledigen dürfen der Zuständige, sein Team, ' +
      'wer sie angelegt hat, und das Büro.',
    bindung: 'frei',
    schema: z.object({
      aufgabe: z.string().trim().min(1, 'Welche Aufgabe?').max(200),
      notiz: z.string().trim().max(1000).optional(),
    }),
    zusammenfassung: (p) => `Aufgabe erledigt: ${p.aufgabe}${p.notiz ? ` — ${p.notiz}` : ''}`,
    formdata: (fd) => ({
      aufgabe: String(fd.get('aufgabe') ?? ''),
      notiz: leerAlsUndefined(fd, 'notiz'),
    }),
    revalidate: ['/aufgaben', '/'],
  },

  'aufgaben.verwerfen': {
    label: 'Aufgabe verwerfen',
    bereich: 'aufgaben',
    prozessfrei: true,
    beschreibung:
      'Nimmt eine Aufgabe zurück, die sich erledigt hat oder falsch angelegt war. Darf, wer sie angelegt hat, und das Büro.',
    bindung: 'frei',
    schema: z.object({ aufgabe_id: uuid }),
    formdata: (fd) => ({ aufgabe_id: String(fd.get('aufgabe_id') ?? '') }),
    revalidate: ['/aufgaben', '/'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
