import { sql } from '@/db/client'

/**
 * Abholen für die Agenten der Druckbrücke (0087): jeder Agent bedient
 * genau EINEN Drucker und zieht nur dessen Aufträge. Abgeholt wird mit
 * Sperre (`for update skip locked` + `abgeholt_am`) — zwei Agenten oder
 * zwei überlappende Abrufe desselben Agenten bekommen nie denselben
 * Auftrag. Bleibt die Quittung aus (Agent abgestürzt, Netz weg), wird der
 * Auftrag nach ABHOL_SPERRE_MINUTEN erneut angeboten.
 *
 * Alt-Agenten ohne Drucker-ID (vor 0087, `?ziele=`) ziehen weiterhin die
 * Aufträge ohne Drucker — mit derselben Sperre.
 */

export const ABHOL_SPERRE_MINUTEN = 2
const JE_ABRUF = 3

export type Abholer = { druckerId: string } | { ziele: string[] | null }

export interface AbgeholterAuftrag {
  id: string
  art: string
  ziel: string
  shipment_id: string | null
  mo_id: string | null
  picking_id: string | null
  variant_id: string | null
  anzahl: number
  shipment_number: string | null
  mo_number: string | null
  label_pdf: Uint8Array | null
  drucker_typ: 'label' | 'a4' | null
  breite_mm: string | null
  hoehe_mm: string | null
}

/** Offene Aufträge für einen Agenten sperren und liefern (älteste zuerst). */
export async function auftraegeAbholen(wer: Abholer): Promise<AbgeholterAuftrag[]> {
  const druckerId = 'druckerId' in wer ? wer.druckerId : null
  const ziele = 'ziele' in wer ? wer.ziele : null
  const gesperrt = await sql<{ id: string }[]>`
    with frei as (
      select id from druckauftraege
      where status = 'offen'
        and (abgeholt_am is null
             or abgeholt_am < now() - make_interval(mins => ${ABHOL_SPERRE_MINUTEN}))
        and (case when ${druckerId}::uuid is not null
               then drucker_id = ${druckerId}::uuid
               else drucker_id is null
                    and (${ziele}::text[] is null or ziel = any(${ziele}::text[])) end)
      order by created_at
      limit ${JE_ABRUF}
      for update skip locked)
    update druckauftraege d set abgeholt_am = now()
    from frei where d.id = frei.id
    returning d.id`
  if (gesperrt.length === 0) return []

  return sql<AbgeholterAuftrag[]>`
    select d.id, d.art, d.ziel, d.shipment_id, d.mo_id, d.picking_id, d.variant_id, d.anzahl,
           s.shipment_number, mo.number as mo_number, s.label_pdf,
           dr.typ as drucker_typ, dr.breite_mm, dr.hoehe_mm
    from druckauftraege d
    left join shipments s on s.id = d.shipment_id
    left join manufacturing_orders mo on mo.id = d.mo_id
    left join drucker dr on dr.id = d.drucker_id
    where d.id = any(${gesperrt.map((g) => g.id)}::uuid[])
    order by d.created_at`
}

/** Das druckfertige PDF eines Auftrags samt Dateiname. */
export async function auftragsPdf(
  job: AbgeholterAuftrag,
): Promise<{ pdf: Buffer; dateiname: string }> {
  switch (job.art) {
    case 'label':
      // Ein Label-Auftrag ohne gespeichertes PDF ist nicht druckbar — der
      // Aufrufer quittiert ihn sofort als Fehler.
      if (!job.label_pdf) throw new Error('Kein Label-PDF an der Sendung gespeichert')
      return { pdf: Buffer.from(job.label_pdf), dateiname: `${job.shipment_number}.pdf` }
    case 'zettel': {
      // Erst hier geladen: das PDF-Modul (react-pdf, .tsx) braucht nur, wer
      // wirklich rendert — Sperre und Routing bleiben unter blankem Node testbar.
      const { moZettelPdf } = await import('@/modules/fertigung/zettel-pdf')
      return {
        pdf: await moZettelPdf([job.mo_id!]),
        dateiname: `${(job.mo_number ?? 'zettel').replaceAll('/', '-')}.pdf`,
      }
    }
    default:
      throw new Error(`Druckart „${job.art}" kann diese Version noch nicht drucken`)
  }
}

/** Nicht druckbar: sofort als Fehler quittieren, damit er nicht ewig kreist. */
export async function auftragFehlgeschlagen(id: string, err: unknown): Promise<void> {
  await sql`update druckauftraege
    set status = 'fehler',
        fehler = ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}
    where id = ${id}`
}

/**
 * Herzschlag eines Drucker-Agenten; liefert den Drucker oder null, wenn es
 * ihn nicht (mehr) gibt. Ein abgeschalteter Drucker meldet sich weiter,
 * bekommt aber keine Aufträge.
 */
export async function druckerMeldetSich(
  druckerId: string,
): Promise<{ id: string; aktiv: boolean } | null> {
  const [d] = await sql<{ id: string; aktiv: boolean }[]>`
    update drucker set zuletzt_gesehen = now()
    where id = ${druckerId}
    returning id, aktiv`
  return d ?? null
}

/**
 * Aktive Drucker, deren Agent sich länger als `minuten` nicht gemeldet hat
 * (oder nie) — die Druckbrücken-Sonde des Dienste-Wächters meldet sie.
 */
export async function stilleDrucker(
  minuten: number,
): Promise<{ name: string; zuletzt_gesehen: string | null }[]> {
  return sql<{ name: string; zuletzt_gesehen: string | null }[]>`
    select name, zuletzt_gesehen::text as zuletzt_gesehen from drucker
    where aktiv
      and (zuletzt_gesehen is null
           or zuletzt_gesehen < now() - make_interval(mins => ${minuten}))
    order by name`
}

/** Gibt es aktive Drucker? Dann zählt deren Herzschlag, nicht der der Alt-Agenten. */
export async function aktiveDruckerVorhanden(): Promise<boolean> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from drucker where aktiv`
  return n > 0
}
