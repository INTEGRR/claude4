import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { money, qty } from '@/modules/shared/format'
import {
  addBomLine,
  addBomOperation,
  copyBom,
  removeBomLine,
  updateBomLine,
  removeBomOperation,
  setBomConsumption,
  setBomLineIssueMethod,
} from '../../actions'
import { RecordComments } from '@/components/record-comments'
import { Auswahl } from '@/components/auswahl'
import { Schublade } from '@/components/schublade'
import { kurzArtikel, kurzEinheiten } from '@/app/(erp)/kurzanlage'

export const dynamic = 'force-dynamic'

/** Merkmal → Werte, in der Reihenfolge des Produkts. */
function nachMerkmal<T extends { merkmal: string; wert: string }>(liste: readonly T[]): [string, T[]][] {
  const gruppen = new Map<string, T[]>()
  for (const x of liste) gruppen.set(x.merkmal, [...(gruppen.get(x.merkmal) ?? []), x])
  return [...gruppen]
}

/**
 * Die Bedingung einer Position als Satz (2026-11-28): „Switches = Jade Gaming
 * und Keycaps = Founders oder Founders Split Space". Innerhalb eines Merkmals
 * „oder", zwischen Merkmalen „und" — genau die Regel, nach der gerechnet wird.
 */
function Bedingung({ filter }: { filter: { merkmal: string; wert: string }[] }) {
  if (filter.length === 0) return <span className="muted small">immer</span>
  const gruppen = nachMerkmal(filter)
  return (
    <span className="bedingung">
      {gruppen.map(([merkmal, werte], i) => (
        <span key={merkmal} className="bedingung-teil">
          {i > 0 && <span className="bedingung-und">und</span>}
          <span className="bedingung-merkmal">{merkmal} =</span>{' '}
          {werte.map((w, j) => (
            <span key={w.wert}>
              {j > 0 && <span className="bedingung-oder"> oder </span>}
              <strong>{w.wert}</strong>
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}

/** Bedingung bearbeiten: je Merkmal eine Zeile mit Häkchen — nichts angehakt heißt „egal". */
function BedingungFelder({
  ptavs,
  gewaehlt,
  teil,
}: {
  ptavs: { id: string; merkmal: string; wert: string }[]
  gewaehlt: string[]
  teil: string
}) {
  if (ptavs.length === 0) return null
  return (
    <fieldset className="bedingung-felder">
      <legend>Wann wird {teil} verbaut?</legend>
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        Nichts anhaken = <strong>immer</strong>, in jeder Variante. Sonst je Merkmal anhaken, bei welcher Wahl des
        Kunden die Position gilt. Hakst du bei <strong>zwei Merkmalen</strong> etwas an, müssen <strong>beide</strong>{' '}
        zutreffen.
      </p>
      {nachMerkmal(ptavs).map(([merkmal, werte]) => (
        <div key={merkmal} className="bedingung-zeile">
          <span className="bedingung-merkmal">{merkmal}</span>
          <span className="bedingung-werte">
            {werte.map((w) => (
              <label key={w.id} className="check">
                <input type="checkbox" name="ptav_ids" value={w.id} defaultChecked={gewaehlt.includes(w.id)} /> {w.wert}
              </label>
            ))}
          </span>
        </div>
      ))}
    </fieldset>
  )
}

export default async function BomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ variante?: string }>
}) {
  const user = await requireArea('fertigung')
  const { id } = await params
  const { variante } = await searchParams

  const [bom] = await sql<
    {
      id: string
      template_id: string
      product: string
      variant: string | null
      qty: number
      uom: string
      consumption: string
      bom_type: string
    }[]
  >`
    select b.id, b.template_id, pt.name as product,
           case when b.variant_id is not null then variant_display_name(b.variant_id) end as variant,
           b.qty, u.name as uom, b.consumption, b.bom_type
    from boms b
    join product_templates pt on pt.id = b.template_id
    join uoms u on u.id = b.uom_id
    where b.id = ${id}`

  if (!bom) notFound()

  const lines = await sql<
    {
      id: string
      component: string
      template_id: string
      sku: string | null
      qty: number
      uom: string
      filters: { merkmal: string; wert: string }[]
      ptav_ids: string[]
      issue_method: string
      is_phantom: boolean
    }[]
  >`
    select l.id, variant_display_name(l.component_variant_id) as component, pv.template_id, pv.sku, l.qty,
           u.name as uom, l.issue_method,
           resolve_kit(l.component_variant_id) is not null as is_phantom,
           coalesce(jsonb_agg(jsonb_build_object('merkmal', a.name, 'wert', av.name) order by al.sequence, a.name, av.sequence)
                    filter (where av.id is not null), '[]'::jsonb) as filters,
           coalesce(array_agg(f.ptav_id::text) filter (where f.ptav_id is not null), '{}') as ptav_ids
    from bom_lines l
    join product_variants pv on pv.id = l.component_variant_id
    join uoms u on u.id = l.uom_id
    left join bom_line_variant_filters f on f.bom_line_id = l.id
    left join product_template_attribute_values ptav on ptav.id = f.ptav_id
    left join product_attribute_values av on av.id = ptav.value_id
    left join product_template_attribute_lines al on al.id = ptav.line_id
    left join product_attributes a on a.id = al.attribute_id
    where l.bom_id = ${id}
    group by l.id, pv.sku, pv.template_id, u.name, l.sequence, l.issue_method, l.component_variant_id
    order by l.sequence`

  // Attributwerte des Endprodukts - die Auswahl für "Auf Varianten anwenden".
  const ptavs = await sql<{ id: string; label: string; merkmal: string; wert: string }[]>`
    select ptav.id, a.name || ': ' || av.name as label, a.name as merkmal, av.name as wert
    from product_template_attribute_lines al
    join product_attributes a on a.id = al.attribute_id
    join product_template_attribute_values ptav on ptav.line_id = al.id
    join product_attribute_values av on av.id = ptav.value_id
    where al.template_id = ${bom.template_id}
    order by al.sequence, av.sequence`

  const variants = await sql<{ id: string; label: string }[]>`
    select id, coalesce(display_name, '(ohne Varianten)') as label
    from product_variants where template_id = ${bom.template_id} and active
    order by display_name`

  // Vorschau: welche Positionen gelten für die gewählte Variante?
  const preview = variante
    ? await sql<
        {
          component: string
          variant_id: string
          qty: number
          uom: string
          available: number
          issue_method: string
          phantom_path: string | null
        }[]
      >`
        select variant_display_name(c.component_variant_id) as component,
               c.component_variant_id as variant_id, c.qty,
               u.name as uom, free_to_use(c.component_variant_id) as available,
               c.issue_method, c.phantom_path
        from bom_explode(${id}, ${variante}, ${1}) c
        join uoms u on u.id = c.uom_id
        order by c.phantom_path nulls first, 1`
    : []

  const operations = await sql<
    {
      id: string
      sequence: number
      name: string
      work_center: string
      code: string
      cost_per_hour: number
      duration_minutes: number
      setup_minutes: number
    }[]
  >`
    select o.id, o.sequence, o.name, w.name as work_center, w.code,
           w.cost_per_hour, o.duration_minutes, o.setup_minutes
    from bom_operations o
    join work_centers w on w.id = o.work_center_id
    where o.bom_id = ${id}
    order by o.sequence, o.id`

  const workCenters = await sql<{ id: string; label: string; cost_per_hour: number }[]>`
    select id, code || ' — ' || name as label, cost_per_hour
    from work_centers where active order by code`

  const components = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) ||
           coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.id <> ${bom.template_id}
    order by label limit 500`

  // Ziele fürs Kopieren: aktive Produkte ohne eigene aktive Stückliste.
  const kopierZiele = await sql<{ id: string; name: string }[]>`
    select pt.id, pt.name
    from product_templates pt
    where pt.active and pt.type = 'goods' and pt.id <> ${bom.template_id}
      and not exists (select 1 from boms b where b.template_id = pt.id and b.active and b.variant_id is null)
    order by pt.name`

  return (
    <>
      <PageHeader
        title={`Stückliste ${bom.product}`}
        subtitle={
          <>
            <Link href={`/produkte/${bom.template_id}`}>zum Produkt {bom.product}</Link> · Referenzmenge {qty(bom.qty)} {bom.uom}
            {bom.variant && <> · gilt nur für {bom.variant}</>}
            {!bom.variant && <> · gilt für alle Varianten</>}
            {bom.bom_type === 'kit' && <> · Baugruppe (wird beim Verwenden aufgelöst)</>}
          </>
        }
        actions={
          <>
            <Link className="btn" href="/fertigung/stuecklisten">Zur Übersicht</Link>
            <Schublade id="stueckliste-kopieren" knopf="Kopieren" titel="Stückliste kopieren">
              <ActionForm action={copyBom.bind(null, bom.id)}>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Kopiert alle Positionen, Arbeitsgänge und Kuppelprodukte auf ein anderes Produkt. „Gilt nur
                  für …" wird über Attribut und Wert umgehängt (z. B. Switches: Linear Yellow). Fehlt ein Wert am
                  Zielprodukt, entfällt er; Positionen ohne übrige Zuordnung werden nicht übernommen und in der
                  Meldung genannt. Danach in der Kopie die Unterschiede ändern.
                </p>
                <div className="row">
                  <label className="field" style={{ flex: 3 }}>
                    <span>Zielprodukt (ohne Stückliste)</span>
                    <Auswahl name="template_id" required defaultValue="">
                      <option value="" disabled>— auswählen —</option>
                      {kopierZiele.map((z) => (
                        <option key={z.id} value={z.id}>{z.name}</option>
                      ))}
                    </Auswahl>
                  </label>
                  <div className="shrink field">
                    <button className="primary" type="submit">Kopieren</button>
                  </div>
                </div>
                {kopierZiele.length === 0 && (
                  <div className="notice warn" style={{ marginBottom: 0 }}>
                    Kein Produkt ohne Stückliste vorhanden — das Zielprodukt zuerst anlegen (Produkte) oder aus
                    Shopify übernehmen.
                  </div>
                )}
              </ActionForm>
            </Schublade>
          </>
        }
      />

      {bom.bom_type === 'kit' && (
        <div className="notice info">
          Diese Stückliste ist eine <strong>Baugruppe</strong> (Odoo: Kit/Phantom). Das Produkt wird
          nie selbst gelagert: In Fertigungsaufträgen, Lieferungen und Demontagen treten immer die
          Bestandteile an seine Stelle — auch mehrstufig, wenn eine Baugruppe wieder eine Baugruppe
          enthält.
        </div>
      )}

      {ptavs.length > 0 && (
        <div className="notice info">
          <strong>So liest sich die Spalte „Wird verbaut, wenn …":</strong> Dort steht, bei welcher Wahl des Kunden
          eine Position in die Tastatur kommt. „Immer" = in jeder Variante. „Mounting Plate = FR4" = nur wenn
          der Kunde FR4 wählt. Stehen zwei Merkmale da, müssen <strong>beide</strong> zutreffen: „Switches = Jade
          Gaming <em>und</em> Keycaps = Founders Split Space" heißt, diese Menge Switches gilt nur für genau diese
          Kombination — so bekommt das Split-Space-Layout seine zwei Switches mehr. Die Bedingung sagt nie, dass
          ein Teil ein anderes ersetzt.
        </div>
      )}

      <Card
        title="Positionen"
        actions={
          <ActionForm action={setBomConsumption.bind(null, id)}>
            <div className="row">
              {/* Label statt dreifach wiederholtem Präfix in den Optionen. */}
              <label className="field" style={{ marginBottom: 0, width: 220 }}>
                <span>Verbrauchsregel</span>
                <Auswahl name="consumption" defaultValue={bom.consumption}>
                  <option value="warning">Abweichung mit Warnung</option>
                  <option value="allowed">Abweichung erlaubt</option>
                  <option value="blocked">Abweichung gesperrt</option>
                </Auswahl>
              </label>
              <div className="shrink">
                <button className="small" type="submit">Speichern</button>
              </div>
            </div>
          </ActionForm>
        }
        tight
      >
        {lines.length === 0 ? (
          <Empty>Noch keine Komponenten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Komponente</th>
                  <th>Artikelnr.</th>
                  <th className="num">Menge</th>
                  <th>Einheit</th>
                  <th>Verbrauch</th>
                  <th>Wird verbaut, wenn …</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/produkte/${l.template_id}`}>{l.component}</Link></td>
                    <td className="mono small">{l.sku ?? '—'}</td>
                    <td className="num">{qty(l.qty)}</td>
                    <td>{l.uom}</td>
                    <td className="nowrap">
                      {l.is_phantom ? (
                        <span className="badge info" title="Baugruppe — wird in ihre Bestandteile aufgelöst">
                          Baugruppe
                        </span>
                      ) : (
                        <ActionButton
                          className="small"
                          action={setBomLineIssueMethod.bind(
                            null,
                            id,
                            l.id,
                            l.issue_method === 'manual' ? 'backflush' : 'manual',
                          )}
                          title={
                            l.issue_method === 'manual'
                              ? 'Muss bei der Fertigmeldung erfasst werden — zum Umstellen klicken'
                              : 'Wird bei der Fertigmeldung automatisch verbraucht — zum Umstellen klicken'
                          }
                        >
                          {l.issue_method === 'manual' ? 'manuell' : 'automatisch'}
                        </ActionButton>
                      )}
                    </td>
                    <td>
                      <Bedingung filter={l.filters} />
                    </td>
                    <td className="nowrap">
                      <span className="actions" style={{ justifyContent: 'flex-end' }}>
                        <Schublade id={`position-${l.id}`} knopf="Ändern" knopfKlasse="small" titel={`${l.component} ändern`}>
                          <ActionForm action={updateBomLine.bind(null, id)}>
                            <input type="hidden" name="line_id" value={l.id} />
                            <label className="field">
                              <span>Menge ({l.uom})</span>
                              <input type="number" name="qty" step="0.001" min="0.001" defaultValue={Number(l.qty)} required />
                            </label>
                            <BedingungFelder ptavs={ptavs} gewaehlt={l.ptav_ids} teil={l.component} />
                            <label className="field">
                              <span>Andere Komponente (leer = bleibt)</span>
                              <Auswahl nachladen="variante" name="component_variant_id" defaultValue="">
                                <option value="">— bleibt: {l.component} —</option>
                                {components.map((c) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </Auswahl>
                            </label>
                            <div className="actions">
                              <button className="primary" type="submit">Speichern</button>
                            </div>
                          </ActionForm>
                        </Schublade>
                        <ActionButton className="small danger" action={removeBomLine.bind(null, id, l.id)}>
                          Entfernen
                        </ActionButton>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <ActionForm action={addBomLine.bind(null, id)}>
            <div className="row">
              <label className="field" style={{ flex: 3 }}>
                <span>Komponente</span>
                <Auswahl nachladen="variante" kurzanlage={kurzArtikel(user, 'einkauf', await kurzEinheiten())} name="component_variant_id" required defaultValue="">
                  <option value="" disabled>— auswählen —</option>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Menge</span>
                <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
              </label>
              <label className="field">
                <span>Verbrauch</span>
                <Auswahl name="issue_method" defaultValue="backflush">
                  <option value="backflush">automatisch (Backflush)</option>
                  <option value="manual">manuell erfassen</option>
                </Auswahl>
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Hinzufügen</button>
              </div>
            </div>
            {ptavs.length > 0 && (
              <details className="bedingung-neu">
                <summary className="small">Nur bei bestimmter Wahl des Kunden verbauen (sonst: immer)</summary>
                <BedingungFelder ptavs={ptavs} gewaehlt={[]} teil="die neue Position" />
              </details>
            )}
          </ActionForm>
        </div>
      </Card>

      {variants.length > 0 && (
        <Card title="Vorschau je Variante">
          <form style={{ marginBottom: 12 }}>
            <div className="row">
              <label className="field" style={{ maxWidth: 320 }}>
                <span>Variante</span>
                <Auswahl name="variante" defaultValue={variante ?? ''}>
                  <option value="">— auswählen —</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </Auswahl>
              </label>
              <div className="shrink field">
                <button type="submit">Anzeigen</button>
              </div>
            </div>
          </form>

          {variante && preview.some((p) => p.phantom_path) && (
            <p className="muted small">
              Baugruppen sind aufgelöst: die Vorschau zeigt die Teile, die im Fertigungsauftrag
              tatsächlich als Bedarf stehen — bezogen auf <strong>ein</strong> Stück.
            </p>
          )}

          {variante &&
            (preview.length === 0 ? (
              <Empty>Für diese Variante gelten keine Positionen.</Empty>
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Komponente</th>
                      <th>Aus Baugruppe</th>
                      <th className="num">Menge</th>
                      <th>Einheit</th>
                      <th>Verbrauch</th>
                      <th className="num">Frei verfügbar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p, i) => {
                      const covered = Number(p.available) >= Number(p.qty)
                      return (
                        <tr key={i}>
                          <td>
                            <Link href={`/produkte/variante/${p.variant_id}`}>{p.component}</Link>
                          </td>
                          <td className="small muted">{p.phantom_path ?? '—'}</td>
                          <td className="num">{qty(p.qty)}</td>
                          <td>{p.uom}</td>
                          <td className="small muted">
                            {p.issue_method === 'manual' ? 'manuell' : 'automatisch'}
                          </td>
                          {/* LED plus Wort statt eingefärbter Zahl. */}
                          <td className="num">
                            <span className={`led ${covered ? 'ok' : 'warn'}`} />{' '}
                            <span className="muted small">{covered ? 'gedeckt' : 'zu wenig'}</span>{' '}
                            {qty(p.available)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
            ))}
        </Card>
      )}
      <Card
        title="Arbeitsgänge"
        actions={
          <Link className="btn small" href="/fertigung/arbeitsplaetze">Arbeitsplätze pflegen</Link>
        }
        tight
      >
        {operations.length === 0 ? (
          <Empty>
            Keine Arbeitsgänge — der Fertigungsauftrag trägt dann nur Materialkosten.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Arbeitsgang</th>
                  <th>Arbeitsplatz</th>
                  <th className="num">Rüstzeit</th>
                  <th className="num">Zeit je {qty(bom.qty)} {bom.uom}</th>
                  <th className="num">Kosten je {qty(bom.qty)} {bom.uom}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {operations.map((o) => (
                  <tr key={o.id}>
                    <td className="mono small">{o.sequence}</td>
                    <td>{o.name}</td>
                    <td>
                      <span className="mono small">{o.code}</span> {o.work_center}
                      <div className="small muted">{money(o.cost_per_hour)} / Std.</div>
                    </td>
                    <td className="num mono">{qty(o.setup_minutes)} Min.</td>
                    <td className="num mono">{qty(o.duration_minutes)} Min.</td>
                    <td className="num mono">
                      {money((Number(o.duration_minutes) / 60) * Number(o.cost_per_hour))}
                    </td>
                    <td className="num">
                      <ActionButton className="small danger" action={removeBomOperation.bind(null, id, o.id)}>
                        Entfernen
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="num mono-label">Lohnkosten je {qty(bom.qty)} {bom.uom}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>
                    {money(
                      operations.reduce(
                        (sum, o) => sum + (Number(o.duration_minutes) / 60) * Number(o.cost_per_hour),
                        0,
                      ),
                    )}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          {workCenters.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Zuerst einen <Link href="/fertigung/arbeitsplaetze">Arbeitsplatz</Link> anlegen — ohne
              Stundensatz gibt es keine Lohnkosten.
            </p>
          ) : (
            <ActionForm action={addBomOperation.bind(null, id)}>
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Arbeitsgang</span>
                  <input name="name" placeholder="Montage" required />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  <span>Arbeitsplatz</span>
                  <Auswahl name="work_center_id" required defaultValue="">
                    <option value="" disabled>— auswählen —</option>
                    {workCenters.map((w) => (
                      <option key={w.id} value={w.id}>{w.label}</option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field">
                  <span>Zeit (Min. je {qty(bom.qty)} {bom.uom})</span>
                  <input type="number" name="duration_minutes" step="0.01" min="0" defaultValue={0} />
                </label>
                <label className="field">
                  <span>Rüstzeit (Min. je Auftrag)</span>
                  <input type="number" name="setup_minutes" step="0.01" min="0" defaultValue={0} />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          )}
        </div>
      </Card>

      <RecordComments model="bom" recordId={id} path={`/fertigung/stuecklisten/${id}`} />
    </>
  )
}
