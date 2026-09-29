import 'server-only'
import { sql } from '@/db/client'
import { druckbrueckeAktiv } from '@/modules/versand/druckbruecke'
import { type Druckart, DRUCKART_LABELS, type Druckweg, druckerFuer } from './routing'

/**
 * Drucken über die Druckbrücke — ein Weg für alle Dokumente (0087,
 * Entscheidungslog 2026-09-29): Arbeitsplatz des Geräts → Druckweg der
 * Druckart → Drucker; ohne eigenen Weg der Ersatzdrucker; ohne beides öffnet
 * das PDF im Browser (der Aufrufer liefert dann den Link).
 *
 * Solange noch KEIN Drucker angelegt ist, läuft die Brücke wie vor 0087 über
 * die alten Ziele („labeldrucker"/„zetteldrucker") — bestehende Agenten
 * drucken weiter, bis die Arbeitsplätze eingerichtet sind.
 */

export interface ZielDrucker {
  id: string
  name: string
  typ: 'label' | 'a4'
  breiteMm: number | null
  hoeheMm: number | null
  dhlFormat: string | null
  /** Arbeitsplatz, an dem der Drucker steht. */
  ort: string | null
  /** true = der Platz hat keinen eigenen Weg, der Ersatzdrucker springt ein. */
  ersatz: boolean
  druckart: Druckart
  /** Arbeitsplatz, von dem gedruckt wird (für Meldung und Auftrag). */
  arbeitsplatzId: string | null
  arbeitsplatzName: string | null
}

export type Beleg =
  | { art: 'label'; shipmentId: string }
  | { art: 'zettel' | 'fertigungsetikett'; moId: string }
  | { art: 'packzettel'; pickingId: string }
  | { art: 'artikeletikett'; variantId: string; anzahl?: number }

/**
 * Der Zieldrucker für eine Druckart am Arbeitsplatz des Geräts — oder null,
 * wenn nicht über konfigurierte Drucker gedruckt wird (Brücke aus, noch
 * keine Drucker angelegt, oder weder eigener Weg noch Ersatz).
 */
export async function zielDrucker(
  arbeitsplatzId: string | null | undefined,
  druckart: Druckart,
): Promise<ZielDrucker | null> {
  if (!(await druckbrueckeAktiv())) return null

  // Ein abgeschalteter oder gelöschter Arbeitsplatz zählt wie keiner.
  const [platz] = arbeitsplatzId
    ? await sql<{ id: string; name: string }[]>`
        select id, name from work_centers where id = ${arbeitsplatzId} and active`
    : []

  const wege = await sql<Druckweg[]>`
    select w.work_center_id, w.druckart, w.drucker_id
    from arbeitsplatz_druckwege w
    join drucker d on d.id = w.drucker_id and d.aktiv
    where w.druckart = ${druckart}`
  const treffer = druckerFuer(wege, platz?.id ?? null, druckart)
  if (!treffer) return null

  const [d] = await sql<
    {
      id: string
      name: string
      typ: 'label' | 'a4'
      breite_mm: string | null
      hoehe_mm: string | null
      dhl_format: string | null
      ort: string | null
    }[]
  >`
    select d.id, d.name, d.typ, d.breite_mm, d.hoehe_mm, d.dhl_format, w.name as ort
    from drucker d left join work_centers w on w.id = d.work_center_id
    where d.id = ${treffer.druckerId}`
  if (!d) return null
  return {
    id: d.id,
    name: d.name,
    typ: d.typ,
    breiteMm: d.breite_mm === null ? null : Number(d.breite_mm),
    hoeheMm: d.hoehe_mm === null ? null : Number(d.hoehe_mm),
    dhlFormat: d.dhl_format,
    ort: d.ort,
    ersatz: treffer.ersatz,
    druckart,
    arbeitsplatzId: platz?.id ?? null,
    arbeitsplatzName: platz?.name ?? null,
  }
}

/** Gibt es überhaupt eingerichtete Drucker? Sonst gilt der Brückenweg vor 0087. */
async function druckerEingerichtet(): Promise<boolean> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from drucker where aktiv`
  return n > 0
}

/** Klartext für die Meldung nach dem Einreihen. */
export function druckMeldung(z: ZielDrucker): string {
  const wo = z.ort ? ` (${z.ort})` : ''
  if (!z.ersatz) return `Gedruckt auf ${z.name}${wo}.`
  const platz = z.arbeitsplatzName
    ? `${z.arbeitsplatzName} hat keinen Drucker für ${DRUCKART_LABELS[z.druckart]}`
    : 'dieser PC hat keinen Arbeitsplatz'
  return `Gedruckt auf ${z.name}${wo} — Ersatzdrucker, ${platz}.`
}

/**
 * Reiht einen Druckauftrag für den Zieldrucker ein — idempotent, solange für
 * denselben Beleg am selben Drucker noch ein offener Auftrag wartet
 * (Doppelklick druckt nicht doppelt; nach dem Druck darf erneut gedruckt
 * werden).
 */
export async function druckEinreihen(
  ziel: ZielDrucker,
  beleg: Beleg,
  von: string,
): Promise<void> {
  const shipmentId = beleg.art === 'label' ? beleg.shipmentId : null
  const moId = beleg.art === 'zettel' || beleg.art === 'fertigungsetikett' ? beleg.moId : null
  const pickingId = beleg.art === 'packzettel' ? beleg.pickingId : null
  const variantId = beleg.art === 'artikeletikett' ? beleg.variantId : null
  const anzahl = beleg.art === 'artikeletikett' ? Math.max(1, Math.min(500, beleg.anzahl ?? 1)) : 1
  const altesZiel = beleg.art === 'label' ? 'labeldrucker' : beleg.art === 'zettel' ? 'zetteldrucker' : beleg.art

  await sql`
    insert into druckauftraege (
      art, shipment_id, mo_id, picking_id, variant_id, anzahl, ziel,
      drucker_id, arbeitsplatz_id, angefordert_von)
    select ${beleg.art}, ${shipmentId}, ${moId}, ${pickingId}, ${variantId}, ${anzahl},
           ${altesZiel}, ${ziel.id}, ${ziel.arbeitsplatzId}, ${von}
    where not exists (
      select 1 from druckauftraege
      where status = 'offen' and drucker_id = ${ziel.id} and art = ${beleg.art}
        and shipment_id is not distinct from ${shipmentId}
        and mo_id is not distinct from ${moId}
        and picking_id is not distinct from ${pickingId}
        and variant_id is not distinct from ${variantId})`
}

/** Ergebnis eines Druckwunschs: gedruckt (mit Meldung) oder PDF im Browser. */
export type DruckErgebnis =
  | { gedruckt: true; meldung: string }
  | { gedruckt: false }

/**
 * Der eine Einstieg für Druckaktionen: am Zieldrucker einreihen, sonst — nur
 * für Labels und Fertigungszettel, und nur solange keine Drucker angelegt
 * sind — über die alten Ziele, sonst Browser. `ziel` darf vorab ermittelt
 * übergeben werden (das DHL-Label braucht das Format schon beim Erzeugen).
 */
export async function drucken(
  druckart: Druckart,
  beleg: Beleg,
  kontext: { arbeitsplatzId?: string | null; von: string },
  ziel?: ZielDrucker | null,
): Promise<DruckErgebnis> {
  const z = ziel === undefined ? await zielDrucker(kontext.arbeitsplatzId, druckart) : ziel
  if (z) {
    await druckEinreihen(z, beleg, kontext.von)
    return { gedruckt: true, meldung: druckMeldung(z) }
  }

  if ((beleg.art === 'label' || beleg.art === 'zettel') && (await druckbrueckeAktiv())) {
    if (!(await druckerEingerichtet())) {
      const shipmentId = beleg.art === 'label' ? beleg.shipmentId : null
      const moId = beleg.art === 'zettel' ? beleg.moId : null
      const altesZiel = beleg.art === 'label' ? 'labeldrucker' : 'zetteldrucker'
      await sql`
        insert into druckauftraege (art, shipment_id, mo_id, ziel, angefordert_von)
        select ${beleg.art}, ${shipmentId}, ${moId}, ${altesZiel}, ${kontext.von}
        where not exists (
          select 1 from druckauftraege
          where status = 'offen' and drucker_id is null and art = ${beleg.art}
            and shipment_id is not distinct from ${shipmentId}
            and mo_id is not distinct from ${moId})`
      return { gedruckt: true, meldung: 'Liegt an der Druckbrücke.' }
    }
  }
  return { gedruckt: false }
}
