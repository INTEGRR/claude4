import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Generische Vorgänge — der Chamäleon-Beleg: eine neue Business-Linie ist
 * ein designter Prozess auf Vorgängen (VG/…), keine entwickelte Fachtabelle.
 * Die Zustände definiert der Prozess (state ist Text); die Schritte belegen
 * `vorgang.status_setzen` mit vorbelegtem Zielzustand (params).
 *
 * Bereich bewusst 'verkauf': die gesäte Muster-Linie (Anfrage) ist
 * vertrieblich; Pakete mit eigenem Berechtigungsraster kommen später.
 */
export const VORGANG = {
  'vorgang.anlegen': {
    label: 'Vorgang anlegen',
    bereich: 'verkauf',
    beschreibung:
      'Startet einen Vorgang in einem Laufzeit-Prozess (modell vorgang) — der Startzustand kommt aus der Prozessdefinition.',
    bindung: 'frei',
    modell: 'vorgang',
    schema: z.object({
      prozess_code: z.string().min(1),
      titel: z.string().max(200).optional(),
      partner_id: z.string().optional(),
      zusatz: z.record(z.unknown()).default({}),
    }),
    zusammenfassung: (p) => `${p.prozess_code}${p.titel ? ` — ${p.titel}` : ''}`,
    formdata: (fd) => ({
      prozess_code: String(fd.get('prozess_code') ?? ''),
      titel: String(fd.get('titel') ?? '').trim() || undefined,
      partner_id: String(fd.get('partner_id') ?? '') || undefined,
      zusatz: {},
    }),
    revalidate: ['/vorgaenge'],
  },

  'vorgang.kopf_aendern': {
    label: 'Vorgangskopf ändern',
    bereich: 'verkauf',
    beschreibung:
      'Ändert Titel, Kunde und eigene Felder eines Vorgangs — OHNE Zustandswechsel, ' +
      'auch im Endzustand (Korrektur). zusatz wird gemerged, nie ersetzt; ein geleertes ' +
      'Feld löscht seinen Wert. Titel/Kunde bleiben bei leerer Eingabe unverändert.',
    bindung: 'beleg',
    modell: 'vorgang',
    // Korrektur-Aktion wie verkauf.kopf_aendern — kein Prozessschritt: sie
    // bewegt den Ablauf nicht, sie pflegt seine Daten.
    prozessfrei: true,
    schema: z.object({
      titel: z.string().max(200).optional(),
      partner_id: z.string().optional(),
      zusatz: z.record(z.unknown()).optional(),
    }),
    zusammenfassung: (p) => {
      const teile = [
        p.titel ? `Titel „${p.titel}"` : null,
        p.partner_id ? 'Kunde' : null,
        p.zusatz && Object.keys(p.zusatz).length ? `${Object.keys(p.zusatz).length} Felder` : null,
      ].filter(Boolean)
      return teile.length ? teile.join(', ') : 'Kopf geändert'
    },
    formdata: (fd) => {
      // Eigene Felder kommen als zusatz.<name>; der LETZTE Wert eines Namens
      // gewinnt (Schalter senden hidden "" + Checkbox "on"). Die Typ-
      // Koerzierung (nummer/schalter) macht die Ausführung — sie kennt die
      // feld_definitionen, das Formular nicht.
      const zusatz: Record<string, unknown> = {}
      for (const key of new Set(fd.keys())) {
        if (!key.startsWith('zusatz.')) continue
        const roh = fd.getAll(key).at(-1)
        zusatz[key.slice('zusatz.'.length)] = typeof roh === 'string' ? roh : ''
      }
      return {
        titel: String(fd.get('titel') ?? '').trim() || undefined,
        partner_id: String(fd.get('partner_id') ?? '') || undefined,
        ...(Object.keys(zusatz).length ? { zusatz } : {}),
      }
    },
    revalidate: ['/vorgaenge/:id', '/vorgaenge'],
  },

  'vorgang.status_setzen': {
    label: 'Vorgang weiterschalten',
    bereich: 'verkauf',
    beschreibung:
      'Setzt den Zustand eines Vorgangs — welcher Zustand wann erlaubt ist, sagt die Prozessdefinition (Schritt-params).',
    bindung: 'beleg',
    modell: 'vorgang',
    schema: z.object({
      state: z.string().min(1).max(60),
      vermerk: z.string().max(1000).optional(),
      zusatz: z.record(z.unknown()).optional(),
    }),
    zusammenfassung: (p) => `→ ${p.state}`,
    formdata: (fd) => ({
      state: String(fd.get('state') ?? ''),
      vermerk: String(fd.get('vermerk') ?? '').trim() || undefined,
    }),
    revalidate: ['/vorgaenge/:id', '/vorgaenge'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
