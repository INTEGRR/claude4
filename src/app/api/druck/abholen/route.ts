import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { agentBerechtigt } from '@/modules/versand/druckbruecke'

/**
 * Abholstelle der Druckbrücke: der Agent auf dem Packtisch-PC
 * (scripts/druck-agent.ts) fragt hier im Takt nach offenen Druckaufträgen
 * und bekommt die Label-PDFs gleich mitgeliefert (base64) — Pull-Modell,
 * weil die App den LAN-Drucker nie erreichen kann.
 *
 * Jeder Abruf hinterlegt seinen Zeitstempel in settings.druckbruecke —
 * die Integrationen-Seite zeigt daran, ob der Agent lebt.
 */

export async function GET(request: Request) {
  if (!agentBerechtigt(request)) {
    return NextResponse.json({ error: 'Kein gültiges Agent-Token' }, { status: 401 })
  }

  await sql`
    insert into settings (key, value)
    values ('druckbruecke', jsonb_build_object('letzter_abruf', now()))
    on conflict (key) do update set value = excluded.value`

  const jobs = await sql<
    {
      id: string
      art: string
      shipment_number: string
      label_pdf: Uint8Array | null
    }[]
  >`
    select d.id, d.art, s.shipment_number, s.label_pdf
    from druckauftraege d
    join shipments s on s.id = d.shipment_id
    where d.status = 'offen'
    order by d.created_at
    limit 3`

  // Ein Auftrag ohne gespeichertes PDF ist nicht druckbar — sofort als
  // Fehler quittieren statt den Agenten ewig dieselbe Leiche ziehen lassen.
  const druckbar: { id: string; art: string; dateiname: string; pdfBase64: string }[] = []
  for (const job of jobs) {
    if (!job.label_pdf) {
      await sql`update druckauftraege
        set status = 'fehler', fehler = 'Kein Label-PDF an der Sendung gespeichert'
        where id = ${job.id}`
      continue
    }
    druckbar.push({
      id: job.id,
      art: job.art,
      dateiname: `${job.shipment_number}.pdf`,
      pdfBase64: Buffer.from(job.label_pdf).toString('base64'),
    })
  }

  return NextResponse.json({ jobs: druckbar })
}
