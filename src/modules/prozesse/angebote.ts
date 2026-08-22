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

/**
 * Die eigenen Felder, die in DIESER Maske erscheinen (Migration 0071).
 *
 * Drei Ebenen, absichtlich in dieser Reihenfolge:
 *  - Felder des PROZESSES (prozess_code gesetzt) — sie entstehen mit dem
 *    Entwurf und gehören nur zu diesem Ablauf.
 *  - Felder des MODELLS (prozess_code null) — gelten für alle Belege der Art,
 *    z. B. ein Feld an jedem Kontakt.
 *  - Je Feld die Schrittliste: null/leer = überall, sonst nur dort.
 *
 * Ohne den Prozessbezug sähen alle Laufzeit-Prozesse dieselben Felder — sie
 * teilen sich das Modell 'vorgang'.
 */
async function eigeneFelder(
  modell: string,
  prozessCode: string | null,
  schrittCode: string | null,
): Promise<{ name: string; label: string; typ: string; pflicht: boolean; auswahl: string[] | null }[]> {
  return sql<
    { name: string; label: string; typ: string; pflicht: boolean; auswahl: string[] | null }[]
  >`
    select name, label, typ, pflicht, auswahl from feld_definitionen
    where modell = ${modell}
      and 'formular' = any(sichtbar_in)
      and (prozess_code is null or prozess_code = ${prozessCode})
      and (schritte is null or cardinality(schritte) = 0
           or ${schrittCode}::text = any(schritte))
    order by prozess_code nulls last, sequence, name`
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
    } else if (quelle === 'vendors') {
      ergebnis.vendors = await sql<{ id: string; label: string }[]>`
        select id, name as label from partners
        where is_vendor and active order by name limit 500`
    } else if (quelle === 'product_variants') {
      ergebnis.product_variants = await sql<{ id: string; label: string }[]>`
        select pv.id, variant_display_name(pv.id) as label
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.active and pt.active order by 2 limit 500`
    } else if (quelle === 'users') {
      ergebnis.users = await sql<{ id: string; label: string }[]>`
        select id, name as label from users where active order by name limit 200`
    } else if (quelle === 'bankkonten') {
      ergebnis.bankkonten = await sql<{ id: string; label: string }[]>`
        select id, name as label from bankkonten where aktiv order by sequence, name limit 50`
    }
  }
  return ergebnis
}

/**
 * Ad-hoc-Maske: EIN Angebot für eine frei gebundene Registry-Aktion — dieselbe
 * Feld- und Optionsmaschine wie das Prozess-Panel, nur ohne Prozesskontext.
 * Trägt das Befehlsfeld: Aktion tippen → Maske steht (deterministisch, ohne
 * KI-Latenz). null, wenn es die Aktion nicht gibt oder sie einen Beleg braucht.
 */
export async function aktionsAngebot(name: string): Promise<SchrittAngebot | null> {
  const eintrag = registrierteAktion(name)
  if (!eintrag || eintrag.bindung !== 'frei') return null

  const felder = formularFelder(eintrag)
  // Ohne Prozesskontext nur die MODELLWEITEN eigenen Felder (prozess_code
  // null) — die Felder eines bestimmten Ablaufs gehören in dessen Maske,
  // nicht in eine Aktion, die ohne ihn aufgerufen wird.
  if (eintrag.modell) {
    for (const f of await eigeneFelder(eintrag.modell, null, null)) {
      felder.push({
        name: `zusatz.${f.name}`,
        label: f.label,
        typ: f.typ as SchrittAngebot['felder'][number]['typ'],
        pflicht: f.pflicht,
        ...(f.auswahl?.length ? { auswahl: f.auswahl } : {}),
      })
    }
  }
  const quellen = new Set<string>()
  for (const feld of felder) {
    if (feld.typ === 'verweis' && feld.quelle) quellen.add(feld.quelle)
  }
  const geladen = await ladeOptionen(quellen)
  const optionen: Record<string, { id: string; label: string }[]> = {}
  for (const feld of felder) {
    if (feld.typ === 'verweis' && feld.quelle && geladen[feld.quelle]) {
      optionen[feld.name] = geladen[feld.quelle]
    }
  }
  return {
    code: name,
    name: eintrag.label,
    aktionsName: name,
    felder,
    vorbelegung: {},
    optionen,
    erlaubt: true,
  }
}

/**
 * Das Startformular eines Laufzeit-Prozesses: die Maske des Schritts, der den
 * Vorgang ANLEGT. `naechsteAngebote` kann das nicht liefern — dort gibt es
 * noch keinen Beleg, an dem entlang traversiert würde.
 *
 * Damit trägt auch der erste Schritt die eigenen Felder des Prozesses. Vorher
 * erschienen sie erst ab dem zweiten: Was der Kunde als „beim Anlegen erfasse
 * ich X" beschrieben hatte, fiel genau dort unter den Tisch.
 */
export async function startAngebot(prozessCode: string): Promise<SchrittAngebot | null> {
  const [schritt] = await sql<
    { code: string; name: string; aktion: string; params: Record<string, unknown> | null }[]
  >`
    select code, name, aktion, params
    from prozess_schritte
    where version_id = prozess_aktive_version(${prozessCode})
      and art = 'aktion' and aktion = 'vorgang.anlegen'
    order by sequence limit 1`
  if (!schritt) return null

  const eintrag = registrierteAktion(schritt.aktion)
  if (!eintrag) return null

  const felder = formularFelder(eintrag)
  if (eintrag.modell) {
    for (const f of await eigeneFelder(eintrag.modell, prozessCode, schritt.code)) {
      felder.push({
        name: `zusatz.${f.name}`,
        label: f.label,
        typ: f.typ as SchrittAngebot['felder'][number]['typ'],
        pflicht: f.pflicht,
        ...(f.auswahl?.length ? { auswahl: f.auswahl } : {}),
      })
    }
  }

  // Der Prozess steht fest (die Seite gehört ihm) — auch wenn die Definition
  // ihn in params vergessen hat.
  const vorbelegung = { ...(schritt.params ?? {}), prozess_code: prozessCode }

  const quellen = new Set<string>()
  for (const feld of felder) {
    if (feld.typ === 'verweis' && feld.quelle && !(feld.name in vorbelegung)) {
      quellen.add(feld.quelle)
    }
  }
  const geladen = await ladeOptionen(quellen)
  const optionen: Record<string, { id: string; label: string }[]> = {}
  for (const feld of felder) {
    if (feld.typ === 'verweis' && feld.quelle && geladen[feld.quelle]) {
      optionen[feld.name] = geladen[feld.quelle]
    }
  }

  return {
    code: schritt.code,
    name: schritt.name,
    aktionsName: schritt.aktion,
    felder,
    vorbelegung,
    optionen,
    erlaubt: true,
  }
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
    // Chamäleon: die eigenen Felder dieses Prozesses und dieses Schritts
    // erscheinen im generierten Formular — als zusatz.<name>, das der Client
    // verschachtelt.
    if (eintrag.modell) {
      for (const f of await eigeneFelder(eintrag.modell, prozessCode, s.code)) {
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
      aktionErlaubt(eintrag, rolle, befugnisse) &&
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
      // Der Schritt verlangt eine persönliche Befugnis — die Oberfläche
      // zeigt ihn als Entscheidung (violett), nicht als Handgriff.
      ...(befugnis ? { befugnis } : {}),
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
