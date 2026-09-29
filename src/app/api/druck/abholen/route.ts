import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import {
  auftraegeAbholen,
  auftragFehlgeschlagen,
  auftragsPdf,
  druckerMeldetSich,
} from '@/modules/druck/abholen'
import { idOderNull } from '@/modules/druck/routing'
import { agentBerechtigt, zieleAusAnfrage } from '@/modules/versand/druckbruecke'

/**
 * Abholstelle der Druckbrücke: der Agent am Arbeitsplatz-PC
 * (scripts/druck-agent.ts) fragt hier im Takt nach offenen Druckaufträgen
 * und bekommt die PDFs gleich mitgeliefert (base64) — Pull-Modell, weil
 * die App die LAN-Drucker nie erreichen kann.
 *
 * Seit 0087 bedient ein Agent genau EINEN Drucker (?drucker=<id>) und
 * zieht nur dessen Aufträge — gesperrt, damit nichts doppelt druckt
 * (modules/druck/abholen.ts). Sein Herzschlag landet am Drucker
 * (zuletzt_gesehen). Alt-Agenten mit ?ziele=… (0078) ziehen weiterhin die
 * Aufträge ohne Drucker; ihr Herzschlag steht in settings.druckbruecke.
 */

export async function GET(request: Request) {
  if (!(await agentBerechtigt(request))) {
    return NextResponse.json({ error: 'Kein gültiges Agent-Token' }, { status: 401 })
  }

  const url = new URL(request.url)
  const druckerParam = url.searchParams.get('drucker')
  let jobs: Awaited<ReturnType<typeof auftraegeAbholen>>

  if (druckerParam) {
    const druckerId = idOderNull(druckerParam)
    const drucker = druckerId ? await druckerMeldetSich(druckerId) : null
    if (!drucker) {
      return NextResponse.json(
        { error: 'Drucker unbekannt — Paket unter Einstellungen → Arbeitsplätze neu laden' },
        { status: 404 },
      )
    }
    jobs = drucker.aktiv ? await auftraegeAbholen({ druckerId: drucker.id }) : []
  } else {
    const ziele = zieleAusAnfrage(url.searchParams.get('ziele'))
    const agent = (url.searchParams.get('name') ?? '').trim() || (ziele?.join('+') ?? 'agent')
    // Herzschlag je Alt-Agent — der Schlüssel trägt auch die Betreiber-
    // Konfig (modus/token), deshalb mergen statt ersetzen.
    await sql`
      insert into settings (key, value)
      values ('druckbruecke', jsonb_build_object('agenten', jsonb_build_object(${agent}::text, now())))
      on conflict (key) do update set value = jsonb_set(
        settings.value || jsonb_build_object(
          'agenten', coalesce(settings.value -> 'agenten', '{}'::jsonb)),
        array['agenten', ${agent}::text], to_jsonb(now()))`
    jobs = await auftraegeAbholen({ ziele })
  }

  const druckbar: {
    id: string
    art: string
    ziel: string
    dateiname: string
    pdfBase64: string
    druckerTyp: 'label' | 'a4' | null
  }[] = []
  for (const job of jobs) {
    try {
      const { pdf, dateiname } = await auftragsPdf(job)
      druckbar.push({
        id: job.id,
        art: job.art,
        ziel: job.ziel,
        dateiname,
        pdfBase64: pdf.toString('base64'),
        druckerTyp: job.drucker_typ,
      })
    } catch (err) {
      await auftragFehlgeschlagen(job.id, err)
    }
  }

  return NextResponse.json({ jobs: druckbar })
}
