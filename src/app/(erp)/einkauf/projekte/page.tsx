import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { PROJEKT_ARTEN } from '@/modules/einkauf/einkaufsprojekt'
import { date } from '@/modules/shared/format'
import { projektAnlegen } from './actions'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'offen', label: 'Laufend', filter: ['bedarf', 'angefragt', 'entschieden', 'bestellt'] },
  { key: 'abgeschlossen', label: 'Abgeschlossen', filter: ['abgeschlossen'] },
  { key: 'abgebrochen', label: 'Abgebrochen', filter: ['abgebrochen'] },
  { key: 'alle', label: 'Alle', filter: ['bedarf', 'angefragt', 'entschieden', 'bestellt', 'abgeschlossen', 'abgebrochen'] },
] as const

/**
 * Einkaufsprojekte (0097): jeder Bedarf vom Anfragen bis zur Lieferung —
 * Positionen mit Zielpreis, Anfragen an mehrere Lieferanten, Angebote im
 * Vergleich, Bestellung. Abgeschlossen, sobald alles geliefert ist.
 */
export default async function ProjektePage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const { ansicht: roh } = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === roh) ?? ANSICHTEN[0]

  const [rows, nutzer] = await Promise.all([
    sql<
      {
        id: string
        nummer: string
        titel: string
        art: keyof typeof PROJEKT_ARTEN
        status: string
        zieltermin: string | null
        verantwortlich: string | null
        positionen: number
        anfragen: number
        angebote: number
        bestellungen: { id: string; number: string }[] | null
        lieferant_id: string | null
        lieferant: string | null
        muster_pflicht: boolean
        golden: boolean
      }[]
    >`
      select ep.id, ep.nummer, ep.titel, ep.art, ep.status::text as status, ep.zieltermin::text as zieltermin,
             ep.muster_pflicht, einkaufsprojekt_golden_sample(ep.id, ep.gewaehltes_angebot_id) as golden,
             u.name as verantwortlich,
             (select count(*)::int from einkaufsprojekt_positionen p where p.projekt_id = ep.id) as positionen,
             (select count(*)::int from lieferantenanfragen a where a.projekt_id = ep.id and a.status <> 'abgesagt') as anfragen,
             (select count(*)::int from lieferantenangebote a where a.projekt_id = ep.id and not a.verworfen) as angebote,
             (select json_agg(json_build_object('id', po.id, 'number', po.number) order by po.number)
                from purchase_orders po
               where po.einkaufsprojekt_id = ep.id and po.state <> 'cancel') as bestellungen,
             la.partner_id as lieferant_id, pa.name as lieferant
      from einkaufsprojekte ep
      left join users u on u.id = ep.verantwortlich_id
      left join lieferantenangebote la on la.id = ep.gewaehltes_angebot_id
      left join partners pa on pa.id = la.partner_id
      where ep.status = any(${ansicht.filter as unknown as string[]}::einkaufsprojekt_status[])
      order by ep.created_at desc
      limit 200`,
    sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
  ])

  return (
    <>
      <PageHeader title="Einkaufsprojekte" subtitle="Bedarf → Anfragen → Angebote vergleichen → bestellen → geliefert" />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/projekte?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Projekte in dieser Ansicht. Ein neues Projekt entsteht unten — mit der ersten Position.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Projekt</th>
                  <th>Art</th>
                  <th className="num">Pos.</th>
                  <th>Anfragen / Angebote</th>
                  <th>Zieltermin</th>
                  <th>Verantwortlich</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/einkauf/projekte/${r.id}`}>
                        <span className="mono">{r.nummer}</span> {r.titel}
                      </Link>
                      {(r.lieferant || r.bestellungen) && (
                        <div className="muted small">
                          {r.lieferant_id && (
                            <Link href={`/einkauf/lieferanten/${r.lieferant_id}`}>{r.lieferant}</Link>
                          )}
                          {r.bestellungen?.map((b, i) => (
                            <span key={b.id}>
                              {i === 0 ? (r.lieferant_id ? ' · ' : '') : ', '}
                              <Link className="mono" href={`/einkauf/${b.id}`}>{b.number}</Link>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {PROJEKT_ARTEN[r.art] ?? r.art}
                      {r.muster_pflicht && (
                        <div>
                          <Link href={`/einkauf/projekte/${r.id}#muster`} className={r.golden ? 'muted' : 'wv-ueberfaellig'}>
                            {r.golden ? 'Golden Sample frei' : 'Musterpflicht'}
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="num mono">{r.positionen}</td>
                    <td className="small nowrap">
                      <Link href={`/einkauf/projekte/${r.id}#anfragen`}>
                        {r.anfragen} / {r.angebote}
                      </Link>
                    </td>
                    <td className="small nowrap">{r.zieltermin ? date(r.zieltermin) : '—'}</td>
                    <td className="small">{r.verantwortlich ?? '—'}</td>
                    <td>
                      <Badge state={r.status} kind="einkaufsprojekt" href={`/einkauf/projekte/${r.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darf && (
        <Card title="Neues Projekt">
          <ActionForm action={projektAnlegen}>
            <div className="row">
              <label className="field">
                <span>Titel</span>
                <input name="titel" required placeholder="z. B. Keycap-Set PBT Nachproduktion" />
              </label>
              <label className="field">
                <span>Art</span>
                <select name="art" defaultValue="nachproduktion">
                  {Object.entries(PROJEKT_ARTEN).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Zieltermin</span>
                <input type="date" name="zieltermin" />
              </label>
              <label className="field">
                <span>Verantwortlich</span>
                <select name="verantwortlich_id" defaultValue={user.id}>
                  {nutzer.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Erste Position</span>
                <input name="pos_bezeichnung" placeholder="Bezeichnung, z. B. Foam-Einlage 60 %" />
              </label>
              <label className="field">
                <span>oder Artikel (SKU)</span>
                <input name="pos_produkt" className="mono" placeholder="SKU oder Barcode" />
              </label>
              <label className="field">
                <span>Menge</span>
                <input name="pos_menge" inputMode="decimal" placeholder="500" />
              </label>
              <label className="field">
                <span>Zielpreis je Stück (€)</span>
                <input name="pos_zielpreis" inputMode="decimal" placeholder="0,85" />
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">
                  Projekt anlegen
                </button>
              </div>
            </div>
            <label className="small" style={{ display: 'block', marginTop: 6 }}>
              <input type="checkbox" name="muster_pflicht" /> <strong>Musterpflicht</strong> — bestellt wird erst, wenn ein
              Golden Sample des gewählten Lieferanten freigegeben ist (Neuteile, Formen)
            </label>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Weitere Positionen, Dateien (Zeichnungen, Stücklisten) und die Lieferanten für die Anfrage kommen im Projekt dazu.
              Der Zielpreis ist der Einstand je Stück in Euro (inkl. Fracht und Zoll) — er geht nie an den Lieferanten.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
