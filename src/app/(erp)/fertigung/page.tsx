import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { Schublade } from '@/components/schublade'
import { cancelMo, createMo, produceMoDirekt } from './actions'
import { FertigungBulk } from './bulk'
import { Auswahl } from '@/components/auswahl'
import { ActionButton } from '@/components/action-button'
import { aufgabenListe } from '@/modules/aufgaben/liste'
import { istFertigungsNachfrage, nachfrageNummern } from '@/modules/verkauf/extern-versand-logik'
import { date } from '@/modules/shared/format'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { Seiten } from '@/components/seiten'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function FertigungPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; produkt?: string; material?: string; auftrag?: string; seite?: string }>
}) {
  const user = await requireArea('fertigung')
  const params = await searchParams
  const { status, produkt: produktRoh, material, auftrag: auftragRoh } = params
  const seite = seitenParameter(params)
  // Das GET-Formular schickt produkt= auch leer mit — ''::uuid wäre ein 500.
  const produkt = produktRoh || undefined
  const nurStartbare = material === 'bereit'
  // „Überfällig" (F4) ist ein Filter über Termin und Zustand, kein Belegstatus.
  const nurUeberfaellig = status === 'ueberfaellig'
  const moStatus = nurUeberfaellig ? undefined : status
  // Filter „Fertigung zum Auftrag" (Querverweis vom Verkauf, „N offen"):
  // nur gültige UUIDs, sonst wäre Unsinn in der Adresszeile ein 500.
  const auftrag = auftragRoh && UUID.test(auftragRoh) ? auftragRoh : undefined
  const [auftragKopf] = auftrag
    ? await sql<{ id: string; number: string; shopify_order_name: string | null }[]>`
        select id, number, shopify_order_name from sales_orders where id = ${auftrag}`
    : []

  const rows = await sql<
    {
      id: string
      number: string
      product: string
      qty_to_produce: number
      qty_produced: number
      state: string
      scheduled_date: string
      sales_order_number: string | null
      sales_order_id: string | null
      template_id: string
      lieferung_id: string | null
      lieferung_number: string | null
      missing: number
    }[]
  >`
    select count(*) over () as gesamt, mo.id, mo.number, variant_display_name(mo.variant_id) as product,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date,
           so.number as sales_order_number, so.id as sales_order_id,
           pv.template_id, lf.id as lieferung_id, lf.number as lieferung_number,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done','cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id
    left join sales_orders so on so.id = mo.sales_order_id
    -- Die Lieferung, auf die der Auftrag wartet: die offene zuerst, sonst
    -- die jüngste (Index origin_model/origin_id).
    left join lateral (
      select sp.id, sp.number
      from stock_pickings sp
      join operation_types ot on ot.id = sp.operation_type_id and ot.kind = 'delivery'
      where sp.origin_model = 'sales_order' and sp.origin_id = so.id
      order by (sp.state in ('done', 'cancel')), sp.scheduled_date desc
      limit 1
    ) lf on true
    where (${moStatus ?? null}::text is null or mo.state = ${moStatus ?? null}::mo_state)
      and (not ${nurUeberfaellig} or (mo.scheduled_date < date_trunc('day', now() at time zone 'Europe/Berlin')
                                     and mo.state not in ('done', 'cancel')))
      and (${produkt ?? null}::uuid is null or mo.variant_id = ${produkt ?? null}::uuid)
      and (${auftrag ?? null}::uuid is null or mo.sales_order_id = ${auftrag ?? null}::uuid)
      -- „Nur startbare" in der Abfrage, nicht nachträglich — sonst stimmen Seiten und Zähler nicht.
      and (not ${nurStartbare} or (mo.state = 'confirmed' and not exists (
             select 1 from stock_moves m
             where m.production_id = mo.id and m.state not in ('done','cancel') and m.reserved_qty < m.qty)))
    order by
      case mo.state when 'progress' then 0 when 'confirmed' then 1 when 'draft' then 2 else 3 end,
      mo.scheduled_date, mo.number
    limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(rows)

  // „Nur startbare": bestätigt UND Material vollständig reserviert — die
  // Auswahlmenge des Bulk-Starts (BUG/00003).
  const gefiltert = nurStartbare
    ? rows.filter((r) => r.state === 'confirmed' && r.missing === 0)
    : rows

  const products = await sql<{ id: string; label: string }[]>`
    select distinct pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and resolve_bom(pv.id) is not null
    order by label limit 300`

  // Adresse mit den übrigen Filtern — Produkt, Material und Auftrag bleiben
  // beim Umschalten des Status erhalten.
  const filterHref = (f: { status?: string; auftrag?: string }) => {
    const params = new URLSearchParams()
    if (f.status) params.set('status', f.status)
    if (produkt) params.set('produkt', produkt)
    if (nurStartbare) params.set('material', 'bereit')
    if (f.auftrag) params.set('auftrag', f.auftrag)
    const query = params.toString()
    return query ? `/fertigung?${query}` : '/fertigung'
  }

  // Versendet (extern 2026-10-15, von Hand gebucht 2026-10-17), der
  // Fertigungsauftrag ist aber noch offen — die Nachfragen ans Team Fertigung,
  // hier, wo entschieden wird (Fertig melden oder stornieren hakt sie ab).
  const nachfragen = (await aufgabenListe(user, 'offen', 500)).filter(
    (a) => a.rolle === 'fertigung' && istFertigungsNachfrage(a.titel),
  )
  const nachfrageNrn = [...new Set(nachfragen.flatMap((a) => nachfrageNummern(a.titel)))]
  // manuell = Komponenten mit Verbrauchsart „manuell": die Fertigmeldung
  // braucht dann Ist-Mengen — Antwort am Auftrag, nicht per Knopf.
  const nachfrageMos = nachfrageNrn.length
    ? await sql<{ id: string; number: string; state: string; sales_order_id: string | null; auftrag: string | null; manuell: boolean }[]>`
        select m.id, m.number, m.state, m.sales_order_id, so.number as auftrag,
               exists (select 1 from stock_moves sm where sm.production_id = m.id and sm.issue_method = 'manual'
                       and sm.state not in ('done', 'cancel')) as manuell
        from manufacturing_orders m left join sales_orders so on so.id = m.sales_order_id
        where m.number = any(${nachfrageNrn})`
    : []
  const moJeNummer = new Map(nachfrageMos.map((m) => [m.number, m]))

  const filters = [
    { key: undefined, label: 'Alle' },
    { key: 'confirmed', label: 'Bestätigt' },
    { key: 'progress', label: 'In Bearbeitung' },
    { key: 'done', label: 'Erledigt' },
    { key: 'ueberfaellig', label: 'Überfällig' },
  ]

  return (
    <>
      <PageHeader
        title="Fertigungsaufträge"
        subtitle="Aufträge aus dem Verkauf (MTO) und manuell angelegte Aufträge"
        actions={<>
            <Link className="btn" href="/fertigung/demontage">Demontage</Link>
            <Schublade id="neu-fertigungsauftrag" knopf="+ Neuer Fertigungsauftrag" titel="Neuer Fertigungsauftrag">
              <ActionForm action={createMo}>
                <div className="row">
                  <label className="field" style={{ flex: 3 }}>
                    <span>Produkt (nur Produkte mit Stückliste)</span>
                    <Auswahl name="variant_id" required defaultValue="">
                      <option value="" disabled>— auswählen —</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </Auswahl>
                  </label>
                  <label className="field">
                    <span>Menge</span>
                    <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
                  </label>
                  <div className="shrink field">
                    <button className="primary" type="submit">Anlegen</button>
                  </div>
                </div>
              </ActionForm>
              {products.length === 0 && (
                <div className="notice warn" style={{ marginBottom: 0 }}>
                  Es gibt noch kein Produkt mit Stückliste. Lege zuerst eine unter{' '}
                  <Link href="/fertigung/stuecklisten">Stücklisten</Link> an.
                </div>
              )}
  
            </Schublade>
          </>}
      />

      {nachfragen.length > 0 && (
        <Card
          title={`Versendet — Fertigung noch durchführen? (${nachfragen.length})`}
          tight
          actions={<Link className="btn small" href="/aufgaben?filter=offen">Alle Aufgaben</Link>}
        >
          <p className="small muted" style={{ margin: '10px 12px 6px' }}>
            Diese Aufträge sind versendet — vom Shop gemeldet (Sendcloud) oder in KRNL von Hand gebucht —, der
            Fertigungsauftrag ist aber noch offen. Die Antwort ist die Buchung: <strong>Ja, gebaut</strong> meldet
            den Auftrag fertig (Material wird verbraucht, Bestand des Erzeugnisses geht auf null);{' '}
            <strong>Nein, nicht gebaut</strong> storniert ihn (dann den Bestand per Inventur korrigieren). Die
            Nachfrage hakt sich damit von selbst ab — abhaken allein stellt nichts fertig.
          </p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Fertigungsauftrag</th>
                  <th>Status</th>
                  <th>Verkaufsauftrag</th>
                  <th>Gemeldet</th>
                  <th>Antwort</th>
                </tr>
              </thead>
              <tbody>
                {nachfragen.map((a) => {
                  const mos = nachfrageNummern(a.titel).map((n) => moJeNummer.get(n) ?? { id: null, number: n, state: '?', sales_order_id: null, auftrag: null })
                  return (
                    <tr key={a.id}>
                      <td className="mono">
                        {mos.map((m, i) => (
                          <span key={m.number}>
                            {i > 0 ? ', ' : ''}
                            {m.id ? <Link href={`/fertigung/${m.id}`}>{m.number}</Link> : m.number}
                          </span>
                        ))}
                      </td>
                      <td>{mos.map((m) => m.state).join(', ')}</td>
                      <td className="mono">
                        {mos[0]?.sales_order_id ? <Link href={`/verkauf/${mos[0].sales_order_id}`}>{mos[0].auftrag}</Link> : '—'}
                      </td>
                      <td className="small mono nowrap">{date(a.faellig_am)}</td>
                      <td className="num">
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {mos.map((m) =>
                            !m.id || m.state === 'done' || m.state === 'cancel' ? null : m.manuell ? (
                              <Link key={m.number} className="btn small" href={`/fertigung/${m.id}`} title="Komponenten mit manueller Verbrauchsart — Ist-Mengen am Auftrag erfassen">
                                {mos.length > 1 ? `${m.number}: ` : ''}Fertig melden am Auftrag
                              </Link>
                            ) : (
                              <ActionButton
                                key={m.number}
                                className="small primary"
                                action={produceMoDirekt.bind(null, m.id)}
                                confirm={`${m.number} fertig melden? Das Material wird laut Stückliste verbraucht.`}
                              >
                                {mos.length > 1 ? `${m.number}: ` : ''}Ja, gebaut → fertig melden
                              </ActionButton>
                            ),
                          )}
                          {mos.map((m) =>
                            !m.id || m.state === 'done' || m.state === 'cancel' ? null : (
                              <ActionButton
                                key={`${m.number}-nein`}
                                className="small"
                                action={cancelMo.bind(null, m.id)}
                                confirm={`${m.number} stornieren? Der Bestand des Erzeugnisses bleibt im Minus — danach per Inventur korrigieren.`}
                              >
                                {mos.length > 1 ? `${m.number}: ` : ''}Nein, nicht gebaut → stornieren
                              </ActionButton>
                            ),
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {auftrag && (
        <div className="notice info">
          <span className="led" style={{ background: 'var(--info)' }} /> Gefiltert auf Auftrag{' '}
          {auftragKopf ? (
            <Link className="mono" href={`/verkauf/${auftragKopf.id}`}>
              {auftragKopf.number}
              {auftragKopf.shopify_order_name ? ` · ${auftragKopf.shopify_order_name}` : ''}
            </Link>
          ) : (
            <span className="muted">(nicht gefunden)</span>
          )}
          {' '}·{' '}
          <Link href={filterHref({ status })}>Filter aufheben</Link>
        </div>
      )}

      <Card tight>
        {/* Filter: der aktive Zustand wird von der LED getragen, nicht von einer
            orangen Fläche — der Akzent bleibt der Primärtaste vorbehalten.
            Produkt/Material bleiben in den Status-Links erhalten. */}
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {filters.map((f) => {
            return (
              <Link
                key={f.label}
                href={filterHref({ status: f.key, auftrag })}
                className="btn small"
                aria-current={status === f.key ? 'page' : undefined}
              >
                <span className={`led ${status === f.key ? 'on' : 'off'}`} />
                {f.label}
              </Link>
            )
          })}
          <form method="get" className="actions" style={{ gap: 8 }}>
            {status && <input type="hidden" name="status" value={status} />}
            {auftrag && <input type="hidden" name="auftrag" value={auftrag} />}
            <Auswahl name="produkt" defaultValue={produkt ?? ''} aria-label="Nach Produkt filtern">
              <option value="">Alle Produkte</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Auswahl>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" name="material" value="bereit" defaultChecked={nurStartbare} />
              <span>nur startbare</span>
            </label>
            <button className="small" type="submit">Filtern</button>
          </form>
        </div>

        {gefiltert.length === 0 ? (
          <Empty>
            Keine Fertigungsaufträge{nurStartbare ? ' mit vollständigem Material' : ''}
            {auftrag ? ' zu diesem Auftrag' : ''}.
          </Empty>
        ) : (
          <TableWrap>
            <FertigungBulk rows={gefiltert} />
          </TableWrap>
        )}
        <Seiten pfad="/fertigung" params={params} seite={seite} gesamt={gesamt} />
      </Card>
    </>
  )
}
