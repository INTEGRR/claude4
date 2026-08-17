import { sql } from '@/db/client'
import type { Role } from '../auth/permissions.ts'
import { registrierteAktion } from './registry/index.ts'
import { formularFelder } from './schema-felder.ts'
import { aktionErlaubt } from './torwaechter.ts'
import type { SchrittAngebot } from '@/components/prozess-aktionen'

/**
 * Baut aus `prozess_naechste_schritte` die Angebote fürs generierte
 * Schrittformular — gemeinsame Logik von Prozess-Panel (Belegseiten) und
 * den /p-Assistenten (beleglose Instanzen): Registry-Schema → Felder,
 * Schritt-params → fixierte Vorbelegung, Verweisfelder → Auswahllisten,
 * Rolle → erlaubt/gesperrt.
 */

export interface NaechsteSchritte {
  angebote: SchrittAngebot[]
  /** Nicht-Aktionsschritte (Dienst/Ereignis/Matching) — das Panel zeigt sie wartend. */
  passiv: { code: string; name: string; art: string }[]
}

/** Auswahllisten der Verweisfelder — einmal je benötigter Quelle laden. */
async function ladeOptionen(
  quellen: Set<string>,
): Promise<Record<string, { id: string; label: string }[]>> {
  const ergebnis: Record<string, { id: string; label: string }[]> = {}
  for (const quelle of quellen) {
    if (quelle === 'partners') {
      ergebnis.partners = await sql<{ id: string; label: string }[]>`
        select id, name as label from partners order by name limit 500`
    } else if (quelle === 'product_variants') {
      ergebnis.product_variants = await sql<{ id: string; label: string }[]>`
        select pv.id, variant_display_name(pv.id) as label
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.active and pt.active order by 2 limit 500`
    } else if (quelle === 'users') {
      ergebnis.users = await sql<{ id: string; label: string }[]>`
        select id, name as label from users where active order by name limit 200`
    }
  }
  return ergebnis
}

export async function naechsteAngebote(
  prozessCode: string,
  recordId: string,
  rolle: Role,
  befugnisse: string[] = [],
): Promise<NaechsteSchritte> {
  const naechste = await sql<
    {
      code: string
      name: string
      art: string
      aktion: string | null
      rollen: string[] | null
      params: Record<string, unknown> | null
    }[]
  >`
    select code, name, art::text as art, aktion, rollen, params
    from prozess_naechste_schritte(${prozessCode}, ${recordId})`

  // Schritt-Befugnisse (Override vor Schrittdefinition) — die Traversierung
  // liefert sie nicht mit, deshalb einmal je Prozess nachgeladen.
  const befugnisJeSchritt = new Map(
    (
      await sql<{ code: string; befugnis: string | null }[]>`
        select s.code, coalesce(o.befugnis, s.befugnis) as befugnis
        from prozesse p
        join prozess_schritte s on s.version_id = prozess_aktive_version(p.code)
        left join prozess_overrides o
          on o.prozess_code = p.code and o.schritt_code = s.code
        where p.code = ${prozessCode}`
    ).map((r) => [r.code, r.befugnis]),
  )

  const angebote: SchrittAngebot[] = []
  const passiv: NaechsteSchritte['passiv'] = []
  const quellen = new Set<string>()

  for (const s of naechste) {
    if (s.art !== 'aktion' || !s.aktion) {
      passiv.push({ code: s.code, name: s.name, art: s.art })
      continue
    }
    const eintrag = registrierteAktion(s.aktion)
    if (!eintrag) continue
    const vorbelegung = s.params ?? {}
    const felder = formularFelder(eintrag)
    // Chamäleon: eigene Felder des Modells (feld_definitionen) erscheinen im
    // generierten Formular — als zusatz.<name>, das der Client verschachtelt.
    if (eintrag.modell) {
      const eigene = await sql<
        { name: string; label: string; typ: string; pflicht: boolean; auswahl: string[] | null }[]
      >`
        select name, label, typ, pflicht, auswahl from feld_definitionen
        where modell = ${eintrag.modell} and 'formular' = any(sichtbar_in)
        order by sequence, name`
      for (const f of eigene) {
        felder.push({
          name: `zusatz.${f.name}`,
          label: f.label,
          typ: f.typ as SchrittAngebot['felder'][number]['typ'],
          pflicht: f.pflicht,
          ...(f.auswahl?.length ? { auswahl: f.auswahl } : {}),
        })
      }
    }
    for (const feld of felder) {
      if (feld.typ === 'verweis' && feld.quelle && !(feld.name in vorbelegung)) {
        quellen.add(feld.quelle)
      }
    }
    // Admin besteht Rollen- und Befugnisprüfung immer (wie im Torwächter).
    const befugnis = befugnisJeSchritt.get(s.code) ?? null
    const erlaubt =
      aktionErlaubt(eintrag, rolle) &&
      (rolle === 'admin' ||
        ((!s.rollen || s.rollen.length === 0 || s.rollen.includes(rolle)) &&
          (!befugnis || befugnisse.includes(befugnis))))
    angebote.push({
      code: s.code,
      name: s.name,
      aktionsName: s.aktion,
      felder,
      vorbelegung,
      optionen: {},
      erlaubt,
      hinweis: erlaubt
        ? s.aktion
        : befugnis && !befugnisse.includes(befugnis)
          ? 'Braucht eine Befugnis aus der Benutzerverwaltung'
          : 'Für Ihre Rolle nicht freigegeben',
    })
  }

  const geladen = await ladeOptionen(quellen)
  for (const angebot of angebote) {
    for (const feld of angebot.felder) {
      if (feld.typ === 'verweis' && feld.quelle && geladen[feld.quelle]) {
        angebot.optionen[feld.name] = geladen[feld.quelle]
      }
    }
  }

  return { angebote, passiv }
}
