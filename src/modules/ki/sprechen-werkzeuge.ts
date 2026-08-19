import { sql } from '@/db/client'
import type { User } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import {
  AktionsFehler,
  aktionErlaubt,
  aktionPruefen as registryPruefen,
} from '@/modules/prozesse/torwaechter'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { kiKatalog } from '@/modules/prozesse/introspektion'
import { AKTIONEN, aktionPruefen as katalogPruefen, type Aktion } from './aktionen'
import { ARGUMENTE, type WerkzeugName } from './sprechen-katalog'
import { varianteSuchen } from './produkt-suche'

/**
 * Dispatcher der Sprachsession-Werkzeuge (POST /api/sprechen/werkzeug).
 *
 * Wirft NIE: jeder Fehler wird als deutscher output-Text zurückgegeben, damit
 * das Sprachmodell ihn vorlesen kann und der Dialog weiterläuft. Schreibende
 * Wünsche werden hier nur GESAMMELT (sprach_vorgaenge, Status offen) —
 * gebucht wird erst nach der Sichtprüfung über /api/sprechen/buchen.
 * Jeder Aufruf endet mit einem Protokolleintrag (rolle 'werkzeug'), den der
 * SERVER schreibt — die Nachvollziehbarkeit hängt nicht am Browser.
 */

export interface WerkzeugErgebnis {
  output: string
  /** Bei aufnahme_abschliessen: der Code des angelegten Prozessentwurfs. */
  entwurf_code?: string
}

export async function werkzeugAusfuehren(
  name: string,
  argumente: unknown,
  nutzer: User,
  protokollId: string | null,
): Promise<WerkzeugErgebnis> {
  let output: string
  let ergebnisFuersProtokoll: unknown = null
  let entwurfCode: string | undefined
  try {
    const schema = ARGUMENTE[name as WerkzeugName]
    if (!schema) {
      output = `Unbekanntes Werkzeug „${name}".`
    } else {
      const geparst = schema.safeParse(argumente)
      if (!geparst.success) {
        const meldungen = geparst.error.issues
          .map((i) => `${i.path.join('.') || 'argumente'}: ${i.message}`)
          .join('; ')
        output = `Ungültige Argumente — ${meldungen}`
      } else {
        const ergebnis = await ausfuehren(name as WerkzeugName, geparst.data, nutzer, protokollId)
        output = ergebnis.output
        ergebnisFuersProtokoll = ergebnis.protokoll ?? null
        entwurfCode = ergebnis.entwurf_code
      }
    }
  } catch (err) {
    output =
      err instanceof Error
        ? err.message.replace(/^error: /, '')
        : 'Das Werkzeug ist fehlgeschlagen.'
  }

  if (protokollId) {
    await sql`
      insert into sprachprotokoll_eintraege (protokoll_id, rolle, text, aktion, ergebnis)
      values (${protokollId}, 'werkzeug', ${output.slice(0, 2000)}, ${name},
              ${ergebnisFuersProtokoll === null ? null : sql.json(ergebnisFuersProtokoll as never)})`
  }
  return entwurfCode ? { output, entwurf_code: entwurfCode } : { output }
}

async function ausfuehren(
  name: WerkzeugName,
  argumente: Record<string, unknown>,
  nutzer: User,
  protokollId: string | null,
): Promise<{ output: string; protokoll?: unknown; entwurf_code?: string }> {
  switch (name) {
    case 'produkt_bestand': {
      const treffer = await varianteSuchen(sql, String(argumente.suchbegriff))
      if (treffer.length === 0) {
        return { output: `Kein Produkt zu „${argumente.suchbegriff}" gefunden.` }
      }
      if (treffer.length === 1) {
        const t = treffer[0]
        const abweichung =
          t.bestand !== t.hauptlager
            ? ` (davon ${t.hauptlager} im Hauptlager — Zählungen buchen dagegen)`
            : ''
        return {
          output: JSON.stringify({
            produkt: t.name,
            sku: t.sku,
            variant_id: t.id,
            bestand: t.bestand,
            hinweis: `Im System stehen ${t.bestand}${abweichung}.`,
          }),
          protokoll: { produkt: t.name, bestand: t.bestand },
        }
      }
      return {
        output: JSON.stringify({
          hinweis: 'Mehrere Kandidaten — nachfragen, welches Produkt gemeint ist.',
          kandidaten: treffer.map((t) => ({
            produkt: t.name,
            sku: t.sku,
            variant_id: t.id,
            bestand: t.bestand,
          })),
        }),
        protokoll: { kandidaten: treffer.map((t) => t.name) },
      }
    }

    case 'vorgang_sammeln': {
      const aktion = String(argumente.aktion)
      const parameter = argumente.parameter as Record<string, unknown>
      const recordId = typeof argumente.record_id === 'string' ? argumente.record_id : undefined
      const zusammenfassung = String(argumente.zusammenfassung)

      // Sofort prüfen (Schema + Rechte), damit die Stimme Lücken direkt
      // meldet — gespeichert wird nur die Absicht, gebucht wird nichts.
      if (aktion.includes('.')) {
        const { aktion: registriert } = registryPruefen(aktion, { parameter, recordId })
        if (!aktionErlaubt(registriert, nutzer.role, nutzer.befugnisse)) {
          throw new AktionsFehler(
            `Dafür fehlt die Berechtigung („${registriert.label}") — der Vorgang wird nicht notiert.`,
          )
        }
      } else {
        const geprueft = katalogPruefen(aktion, parameter)
        if (!canWrite(nutzer.role, geprueft.aktion.bereich)) {
          throw new AktionsFehler(
            `Dafür fehlt die Berechtigung („${geprueft.aktion.label}") — der Vorgang wird nicht notiert.`,
          )
        }
      }

      if (!protokollId) {
        throw new AktionsFehler('Keine aktive Sitzung — der Vorgang kann nicht notiert werden.')
      }
      const [zeile] = await sql<{ seq: number }[]>`
        insert into sprach_vorgaenge (protokoll_id, seq, aktion, parameter, record_id, zusammenfassung)
        values (${protokollId},
                coalesce((select max(seq) from sprach_vorgaenge where protokoll_id = ${protokollId}), 0) + 1,
                ${aktion}, ${sql.json(parameter as never)}, ${recordId ?? null},
                ${zusammenfassung.slice(0, 300)})
        returning seq`
      return {
        output: `Notiert (Position ${zeile.seq}): ${zusammenfassung}. Gebucht wird nach der Sichtprüfung am Bildschirm.`,
        protokoll: { seq: zeile.seq, aktion, zusammenfassung },
      }
    }

    case 'aktionen_suchen': {
      const begriff = String(argumente.begriff).toLowerCase()
      const passt = (text: string) => text.toLowerCase().includes(begriff)

      const registry = kiKatalog()
        .filter((a) => passt(a.name) || passt(a.label) || passt(a.beschreibung))
        .filter((a) => {
          const def = registrierteAktion(a.name)
          return def ? aktionErlaubt(def, nutzer.role, nutzer.befugnisse) : false
        })
        .map((a) => ({ name: a.name, label: a.label, beschreibung: a.beschreibung, felder: a.felder }))

      const katalog = Object.entries(AKTIONEN as Record<string, Aktion>)
        .filter(([n, a]) => passt(n) || passt(a.label) || passt(a.beschreibung))
        .filter(([, a]) => canWrite(nutzer.role, a.bereich))
        .map(([n, a]) => ({ name: n, label: a.label, beschreibung: a.beschreibung }))

      const treffer = [...registry, ...katalog].slice(0, 5)
      if (treffer.length === 0) {
        return { output: `Keine passende Aktion zu „${argumente.begriff}" gefunden.` }
      }
      return {
        output: JSON.stringify({
          hinweis: 'Passende Aktionen — mit vorgang_sammeln notieren, nicht direkt ausführen.',
          aktionen: treffer,
        }),
        protokoll: { treffer: treffer.map((t) => t.name) },
      }
    }

    case 'datenfrage': {
      // Stufe 3 — Modul datenfrage.ts. Bis dahin ist das Werkzeug nicht im
      // Katalog; die Weiche existiert, damit der Dispatcher vollständig ist.
      const { datenfrageBeantworten } = await import('./datenfrage')
      const antwort = await datenfrageBeantworten(String(argumente.frage), nutzer)
      return { output: antwort, protokoll: { frage: argumente.frage } }
    }

    case 'aufnahme_abschliessen': {
      // Prozess-Aufnahme: das Sitzungstranskript wird zu einem
      // prozess_entwerfen-ENTWURF strukturiert (nichts wird aktiv; nurAdmin
      // erzwingt der Torwächter in der Strukturierung).
      if (!protokollId) {
        throw new AktionsFehler('Keine aktive Sitzung — es gibt kein Transkript.')
      }
      const zeilen = await sql<{ rolle: string; text: string }[]>`
        select rolle, text from sprachprotokoll_eintraege
        where protokoll_id = ${protokollId} and rolle in ('nutzer', 'assistent')
        order by zeit`
      const transkript = zeilen
        .map((z) => `${z.rolle === 'nutzer' ? 'Kunde/Berater' : 'Interviewer'}: ${z.text}`)
        .join('\n')
      const { aufnahmeStrukturieren } = await import('./prozess-aufnahme')
      const antwort = await aufnahmeStrukturieren(transkript, String(argumente.titel), nutzer)
      return {
        output: antwort.text,
        protokoll: { titel: argumente.titel, code: antwort.code ?? null },
        entwurf_code: antwort.code,
      }
    }

    case 'sitzung_beenden':
      // Behandelt der Client selbst (Verbindung trennen) — Rückfallebene.
      return { output: 'Sitzung wird beendet.' }
  }
}
