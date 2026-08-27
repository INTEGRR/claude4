import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { moZettelPdf } from '@/modules/fertigung/zettel-pdf'
import { agentBerechtigt, zieleAusAnfrage } from '@/modules/versand/druckbruecke'

/**
 * Abholstelle der Druckbrücke: der Agent auf dem Packtisch-/Werkstatt-PC
 * (scripts/druck-agent.ts) fragt hier im Takt nach offenen Druckaufträgen
 * und bekommt die PDFs gleich mitgeliefert (base64) — Pull-Modell, weil
 * die App die LAN-Drucker nie erreichen kann.
 *
 * Mehrstationig (0078): jeder Auftrag trägt ein ZIEL (labeldrucker,
 * zetteldrucker, …), und der Agent nennt per ?ziele=… die Ziele, die er
 * bedient — ein Agent je Drucker, beliebig viele Agenten/PCs. Ohne
 * ziele-Parameter zieht er alles (Ein-PC-Aufbau). Labels kommen aus der
 * gespeicherten Sendung, Zettel werden frisch als PDF gerendert.
 *
 * Jeder Abruf hinterlegt seinen Zeitstempel je Agent in
 * settings.druckbruecke — die Integrationen-Seite zeigt daran, welche
 * Agenten leben.
 */

export async function GET(request: Request) {
  if (!agentBerechtigt(request)) {
    return NextResponse.json({ error: 'Kein gültiges Agent-Token' }, { status: 401 })
  }

  const url = new URL(request.url)
  const ziele = zieleAusAnfrage(url.searchParams.get('ziele'))
  const agent = (url.searchParams.get('name') ?? '').trim() || (ziele?.join('+') ?? 'agent')

  await sql`
    insert into settings (key, value)
    values ('druckbruecke', jsonb_build_object('agenten', jsonb_build_object(${agent}::text, now())))
    on conflict (key) do update set value = jsonb_set(
      case when settings.value ? 'agenten' then settings.value
           else jsonb_build_object('agenten', '{}'::jsonb) end,
      array['agenten', ${agent}::text], to_jsonb(now()))`

  const jobs = await sql<
    {
      id: string
      art: string
      ziel: string
      mo_id: string | null
      shipment_number: string | null
      mo_number: string | null
      label_pdf: Uint8Array | null
    }[]
  >`
    select d.id, d.art, d.ziel, d.mo_id,
           s.shipment_number, mo.number as mo_number, s.label_pdf
    from druckauftraege d
    left join shipments s on s.id = d.shipment_id
    left join manufacturing_orders mo on mo.id = d.mo_id
    where d.status = 'offen'
      and (${ziele}::text[] is null or d.ziel = any(${ziele}::text[]))
    order by d.created_at
    limit 3`

  const druckbar: { id: string; art: string; ziel: string; dateiname: string; pdfBase64: string }[] = []
  for (const job of jobs) {
    try {
      let pdf: Buffer
      let name: string
      if (job.art === 'label') {
        // Ein Label-Auftrag ohne gespeichertes PDF ist nicht druckbar —
        // sofort als Fehler quittieren statt den Agenten ewig dieselbe
        // Leiche ziehen lassen.
        if (!job.label_pdf) throw new Error('Kein Label-PDF an der Sendung gespeichert')
        pdf = Buffer.from(job.label_pdf)
        name = `${job.shipment_number}.pdf`
      } else {
        pdf = await moZettelPdf([job.mo_id!])
        name = `${(job.mo_number ?? 'zettel').replaceAll('/', '-')}.pdf`
      }
      druckbar.push({
        id: job.id,
        art: job.art,
        ziel: job.ziel,
        dateiname: name,
        pdfBase64: pdf.toString('base64'),
      })
    } catch (err) {
      await sql`update druckauftraege
        set status = 'fehler',
            fehler = ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}
        where id = ${job.id}`
    }
  }

  return NextResponse.json({ jobs: druckbar })
}
