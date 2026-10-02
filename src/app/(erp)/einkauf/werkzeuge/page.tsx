import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { WerkzeugSchuesse } from '@/components/werkzeug-schuesse'
import { EIGENTUEMER, WERKZEUG_ARTEN, WERKZEUG_STATUS } from '@/modules/einkauf/werkzeuge'
import { money } from '@/modules/shared/format'
import { werkzeugAnlegen } from './actions'
import { Auswahl } from '@/components/auswahl'
import { kurzLieferant } from '@/app/(erp)/kurzanlage'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ANSICHTEN = [
  { key: 'betrieb', label: 'In Betrieb & in Auftrag', filter: ['aktiv', 'in_auftrag'] },
  { key: 'gesperrt', label: 'Gesperrt', filter: ['gesperrt'] },
  { key: 'ausgemustert', label: 'Ausgemustert', filter: ['ausgemustert'] },
  { key: 'alle', label: 'Alle', filter: ['in_auftrag', 'aktiv', 'gesperrt', 'ausgemustert'] },
] as const

/**
 * Werkzeuge und Formen beim Lieferanten (0107): wo welche Form steht, wem
 * sie gehört, was sie gekostet hat, wie viele Schuss sie noch hat. Bestellt
 * ein Einkaufsprojekt Werkzeugkosten, entsteht der Eintrag von selbst.
 */
export default async function WerkzeugePage({
  searchParams,
}: {
  searchParams: Promise<{ ansicht?: string; projekt?: string; lieferant?: string }>
}) {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const sp = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === sp.ansicht) ?? ANSICHTEN[0]
  const vorProjekt = sp.projekt && UUID.test(sp.projekt) ? sp.projekt : ''
  const vorLieferant = sp.lieferant && UUID.test(sp.lieferant) ? sp.lieferant : ''

  const [rows, lieferanten, projekte, waehrungen, zeilen] = await Promise.all([
    sql<
      {
        id: string
        nummer: string
        bezeichnung: string
        art: keyof typeof WERKZEUG_ARTEN
        eigentuemer: keyof typeof EIGENTUEMER
        status: string
        schuss_zaehler: number
        lebensdauer_schuss: number | null
        kosten: number | null
        waehrung: string
        partner_id: string
        lieferant: string
        template_id: string | null
        artikel: string | null
        projekt_id: string | null
        projekt_nummer: string | null
        po_id: string | null
        po_nummer: string | null
      }[]
    >`
      select w.id, w.nummer, w.bezeichnung, w.art, w.eigentuemer, w.status::text as status, w.schuss_zaehler,
             w.lebensdauer_schuss, w.kosten::float as kosten, w.waehrung,
             pa.id as partner_id, pa.name as lieferant, pt.id as template_id, pt.name as artikel,
             ep.id as projekt_id, ep.nummer as projekt_nummer, po.id as po_id, po.number as po_nummer
      from werkzeuge w
      join partners pa on pa.id = w.partner_id
      left join product_templates pt on pt.id = w.template_id
      left join einkaufsprojekte ep on ep.id = w.einkaufsprojekt_id
      left join purchase_order_lines l on l.id = w.purchase_order_line_id
      left join purchase_orders po on po.id = l.order_id
      where w.status = any(${ansicht.filter as unknown as string[]}::werkzeug_status[])
      order by pa.name, w.nummer
      limit 500`,
    sql<{ id: string; name: string }[]>`select id, name from partners where is_vendor and active order by lower(name) limit 500`,
    sql<{ id: string; label: string }[]>`
      select id, nummer || ' · ' || titel as label from einkaufsprojekte
      where status not in ('abgeschlossen', 'abgebrochen') or id = ${vorProjekt || null}::uuid
      order by created_at desc limit 100`,
    sql<{ code: string }[]>`select code from currencies where active order by code = 'EUR' desc, code`,
    // Werkzeugkosten-Zeilen, die noch an keinem Werkzeug hängen.
    sql<{ id: string; label: string }[]>`
      select l.id, po.number || ' · ' || pa.name || ' · ' || l.name || ' · ' ||
             to_char(l.qty * l.price_unit, 'FM999G999G990D00') || ' ' || po.currency as label
      from purchase_order_lines l
      join purchase_orders po on po.id = l.order_id and po.state <> 'cancel'
      join partners pa on pa.id = po.vendor_id
      where l.name ilike 'werkzeug%'
        and not exists (select 1 from werkzeuge w where w.purchase_order_line_id = l.id)
      order by po.created_at desc limit 50`,
  ])

  return (
    <>
      <PageHeader title="Werkzeuge & Formen" subtitle="Was beim Lieferanten steht, wem es gehört, wie viele Schuss es noch hat" />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/werkzeuge?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Werkzeuge in dieser Ansicht. Werkzeugkosten aus einem Einkaufsprojekt legen sie beim Bestellen an.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Werkzeug</th>
                  <th>Standort</th>
                  <th>Artikel / Projekt</th>
                  <th>Schuss</th>
                  <th className="num">Kosten</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link href={`/einkauf/werkzeuge/${w.id}`}>
                        <span className="mono">{w.nummer}</span> {w.bezeichnung}
                      </Link>
                      <div className="muted small">
                        {WERKZEUG_ARTEN[w.art] ?? w.art} · Eigentum {EIGENTUEMER[w.eigentuemer]}
                      </div>
                    </td>
                    <td className="small">
                      <Link href={`/einkauf/lieferanten/${w.partner_id}`}>{w.lieferant}</Link>
                    </td>
                    <td className="small">
                      {w.template_id ? <Link href={`/produkte/${w.template_id}`}>{w.artikel}</Link> : '—'}
                      {w.projekt_id && (
                        <div>
                          <Link className="mono" href={`/einkauf/projekte/${w.projekt_id}`}>
                            {w.projekt_nummer}
                          </Link>
                          {w.po_id && (
                            <>
                              {' · '}
                              <Link className="mono" href={`/einkauf/${w.po_id}`}>
                                {w.po_nummer}
                              </Link>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <WerkzeugSchuesse zaehler={w.schuss_zaehler} lebensdauerSchuss={w.lebensdauer_schuss} />
                    </td>
                    <td className="num small">{w.kosten !== null ? money(w.kosten, w.waehrung) : '—'}</td>
                    <td>
                      <Badge state={w.status} kind="werkzeug" href={`/einkauf/werkzeuge/${w.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darf && (
        <Card title="Neues Werkzeug">
          <ActionForm action={werkzeugAnlegen}>
            <div className="row">
              <label className="field" style={{ flex: 2 }}>
                <span>Bezeichnung</span>
                <input name="bezeichnung" required placeholder="z. B. Form Keycap-Set 2K, 4-fach" />
              </label>
              <label className="field">
                <span>Art</span>
                <Auswahl name="art" defaultValue="form">
                  {Object.entries(WERKZEUG_ARTEN).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Standort (Lieferant)</span>
                <Auswahl kurzanlage={kurzLieferant(user)} name="partner_id" defaultValue={vorLieferant}>
                  <option value="">— aus der Bestellzeile —</option>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Eigentümer</span>
                <Auswahl name="eigentuemer" defaultValue="wir">
                  {Object.entries(EIGENTUEMER).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
            </div>
            <div className="row">
              <label className="field shrink">
                <span>Kosten</span>
                <input name="kosten" inputMode="decimal" placeholder="18.000" />
              </label>
              <label className="field shrink">
                <span>Währung</span>
                <Auswahl name="waehrung" defaultValue="" className="mono">
                  <option value="">—</option>
                  {waehrungen.map((w) => (
                    <option key={w.code} value={w.code}>
                      {w.code}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Lebensdauer (Schuss)</span>
                <input name="lebensdauer_schuss" inputMode="numeric" placeholder="300.000" />
              </label>
              <label className="field shrink">
                <span>Zählerstand</span>
                <input name="schuss_zaehler" inputMode="numeric" placeholder="0" />
              </label>
              <label className="field shrink">
                <span>Status</span>
                <Auswahl name="status" defaultValue="in_auftrag">
                  {Object.entries(WERKZEUG_STATUS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Einkaufsprojekt</span>
                <Auswahl name="einkaufsprojekt_id" defaultValue={vorProjekt}>
                  <option value="">—</option>
                  {projekte.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Artikel (SKU)</span>
                <input name="produkt" className="mono" placeholder="SKU, Barcode oder Name" />
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Werkzeugkosten-Zeile einer Bestellung</span>
                <Auswahl name="purchase_order_line_id" defaultValue="">
                  <option value="">—</option>
                  {zeilen.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </Auswahl>
              </label>
            </div>
            <label className="field">
              <span>Notiz</span>
              <textarea name="notiz" rows={2} placeholder="z. B. Werkzeugnummer des Lieferanten, Kavitäten, Material" />
            </label>
            <button className="primary" type="submit">
              Werkzeug anlegen
            </button>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Mit einer Bestellzeile kommen Lieferant, Kosten, Währung und Projekt von dort. Zeichnungen und Fotos hängen
              danach als Dokumente am Werkzeug.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
