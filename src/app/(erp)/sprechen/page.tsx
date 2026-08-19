import { requireArea } from '@/modules/auth'
import { currentUser } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader } from '@/components/ui'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { formularFelder } from '@/modules/prozesse/schema-felder'
import { AKTIONEN, type Aktion } from '@/modules/ki/aktionen'
import { sprechenKonfiguriert, sprechenModell } from '@/modules/ki/sprechen'
import { Gespraech } from './gespraech'
import { Pruefung, type PruefVorgang } from './pruefung'
import { ProtokollListe } from './protokoll-liste'

export const dynamic = 'force-dynamic'

/**
 * Der Echtzeit-Sprachmodus: Gespräch führen (WebRTC, Hexcore als Zustands-
 * anzeige, kompaktes Live-Log), danach die gesammelten Vorgänge in der
 * Prüftabelle gegenchecken und im Bulk buchen. Vergangene Sitzungen stehen
 * als Historie darunter.
 */
export default async function SprechenSeite() {
  await requireArea('ki')
  const user = (await currentUser())!

  if (!sprechenKonfiguriert()) {
    return (
      <>
        <PageHeader title="Sprechen" subtitle="Echtzeit-Gespräch mit dem ERP" />
        <Card title="Nicht konfiguriert">
          <Empty>
            Der Sprachmodus braucht den <span className="mono">OPENAI_API_KEY</span> (derselbe wie
            für die Diktierfunktion). Sobald er gesetzt ist, erscheint hier der Verbinden-Knopf.
          </Empty>
        </Card>
      </>
    )
  }

  const label = (aktion: string) =>
    registrierteAktion(aktion)?.label ??
    (AKTIONEN as Record<string, Aktion>)[aktion]?.label ??
    aktion

  // Parameter mit deutschen Feldlabels für die Prüftabelle — dieselben
  // Beschriftungen wie in den generierten Masken (formularFelder).
  const werteMitLabels = (aktion: string, parameter: Record<string, unknown>) => {
    const def = registrierteAktion(aktion)
    const labels = new Map(def ? formularFelder(def).map((f) => [f.name, f.label]) : [])
    return Object.entries(parameter)
      .filter(([, w]) => w !== null && w !== undefined && w !== '')
      .map(([k, w]) => ({ label: labels.get(k) ?? k, wert: String(w).slice(0, 60) }))
  }

  // Offene Sammlungen: Sitzungen dieses Nutzers mit noch offenen Vorgängen.
  const offeneVorgaenge = await sql<
    {
      id: string
      protokoll_id: string
      begonnen_am: string
      seq: number
      aktion: string
      parameter: Record<string, unknown>
      zusammenfassung: string
      status: string
      ergebnis_text: string | null
    }[]
  >`
    select v.id, v.protokoll_id, p.begonnen_am, v.seq, v.aktion, v.parameter,
           v.zusammenfassung, v.status, v.ergebnis_text
    from sprach_vorgaenge v
    join sprachprotokolle p on p.id = v.protokoll_id
    where p.user_id = ${user.id}
      and exists (select 1 from sprach_vorgaenge o
                  where o.protokoll_id = v.protokoll_id and o.status = 'offen')
    order by p.begonnen_am desc, v.seq
    limit 200`

  const sammlungen = new Map<string, { begonnen_am: string; vorgaenge: PruefVorgang[] }>()
  for (const v of offeneVorgaenge) {
    if (!sammlungen.has(v.protokoll_id)) {
      sammlungen.set(v.protokoll_id, { begonnen_am: v.begonnen_am, vorgaenge: [] })
    }
    sammlungen.get(v.protokoll_id)!.vorgaenge.push({
      id: v.id,
      seq: v.seq,
      aktion: v.aktion,
      label: label(v.aktion),
      parameter: v.parameter,
      werte: werteMitLabels(v.aktion, v.parameter),
      zusammenfassung: v.zusammenfassung,
      status: v.status as PruefVorgang['status'],
      ergebnis_text: v.ergebnis_text,
    })
  }

  // Historie: abgeschlossene Sitzungen (ohne offene Vorgänge), kompakt.
  const historie = await sql<
    {
      id: string
      begonnen_am: string
      beendet_am: string | null
      eintraege: number
      gebucht: number
    }[]
  >`
    select p.id, p.begonnen_am, p.beendet_am,
           (select count(*) from sprachprotokoll_eintraege e where e.protokoll_id = p.id)::int as eintraege,
           (select count(*) from sprach_vorgaenge v
             where v.protokoll_id = p.id and v.status = 'gebucht')::int as gebucht
    from sprachprotokolle p
    where p.user_id = ${user.id}
      and not exists (select 1 from sprach_vorgaenge o
                      where o.protokoll_id = p.id and o.status = 'offen')
    order by p.begonnen_am desc
    limit 10`

  return (
    <>
      <PageHeader
        title="Sprechen"
        subtitle={`Echtzeit-Gespräch mit dem ERP (${sprechenModell()}) — Schreibwünsche werden gesammelt und nach der Sitzung gebucht`}
      />
      <Gespraech />
      {/* Die Prozess-Aufnahme ist ein Einstellungs-Thema, kein Alltagsmodus —
          sie wohnt in der Werkstatt (Entscheidungslog 2026-08-19). */}
      {user.role === 'admin' && (
        <p className="muted small" style={{ textAlign: 'center' }}>
          Prozesse aufnehmen und bauen: <a href="/prozesse/werkstatt">Prozess-Werkstatt</a>
        </p>
      )}
      {[...sammlungen.entries()].map(([protokollId, s]) => (
        <Pruefung
          key={protokollId}
          protokollId={protokollId}
          begonnenAm={s.begonnen_am}
          vorgaenge={s.vorgaenge}
        />
      ))}
      <ProtokollListe sitzungen={historie} />
    </>
  )
}
