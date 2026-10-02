import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { DokumenteKarte } from '@/components/dokumente'
import { WiedervorlagenKarte } from '@/components/mail-threads'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, PageHeader } from '@/components/ui'
import { WerkzeugSchuesse } from '@/components/werkzeug-schuesse'
import { EIGENTUEMER, WERKZEUG_ARTEN, WERKZEUG_STATUS, lebensdauer } from '@/modules/einkauf/werkzeuge'
import { dateTime, money } from '@/modules/shared/format'
import { werkzeugAendern, werkzeugSchussBuchen, werkzeugStatusSetzen } from '../actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ein Werkzeug (0107): Stammdaten, Standort, Eigentum, Kosten mit der
 * Bestellzeile, Schuss-Zähler (buchen, korrigieren), Status mit Grund,
 * Zeichnungen und Fotos, Wiedervorlagen (auch die der Lebensdauer), Verlauf.
 */
export default async function WerkzeugPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const pfad = `/einkauf/werkzeuge/${id}`

  const [w] = await sql<
    {
      id: string
      nummer: string
      bezeichnung: string
      art: keyof typeof WERKZEUG_ARTEN
      eigentuemer: keyof typeof EIGENTUEMER
      status: keyof typeof WERKZEUG_STATUS
      status_grund: string | null
      schuss_zaehler: number
      lebensdauer_schuss: number | null
      kosten: number | null
      waehrung: string
      notiz: string | null
      erstellt_von: string | null
      created_at: string
      partner_id: string
      lieferant: string
      template_id: string | null
      artikel: string | null
      projekt_id: string | null
      projekt: string | null
      zeile_id: string | null
      zeile: string | null
      po_id: string | null
      po_nummer: string | null
    }[]
  >`
    select w.id, w.nummer, w.bezeichnung, w.art, w.eigentuemer, w.status::text as status, w.status_grund,
           w.schuss_zaehler, w.lebensdauer_schuss, w.kosten::float as kosten, w.waehrung, w.notiz, w.erstellt_von,
           w.created_at::text as created_at, pa.id as partner_id, pa.name as lieferant,
           pt.id as template_id, pt.name as artikel, ep.id as projekt_id, ep.nummer || ' ' || ep.titel as projekt,
           l.id as zeile_id, l.name as zeile, po.id as po_id, po.number as po_nummer
    from werkzeuge w
    join partners pa on pa.id = w.partner_id
    left join product_templates pt on pt.id = w.template_id
    left join einkaufsprojekte ep on ep.id = w.einkaufsprojekt_id
    left join purchase_order_lines l on l.id = w.purchase_order_line_id
    left join purchase_orders po on po.id = l.order_id
    where w.id = ${id}`
  if (!w) notFound()

  const [lieferanten, projekte, waehrungen] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from partners where is_vendor and active order by lower(name) limit 500`,
    sql<{ id: string; label: string }[]>`
      select id, nummer || ' · ' || titel as label from einkaufsprojekte
      where status not in ('abgeschlossen', 'abgebrochen') or id = ${w.projekt_id}::uuid
      order by created_at desc limit 100`,
    sql<{ code: string }[]>`select code from currencies where active order by code = 'EUR' desc, code`,
  ])
  const ld = lebensdauer(w.schuss_zaehler, w.lebensdauer_schuss)
  const statusWechsel = (Object.keys(WERKZEUG_STATUS) as (keyof typeof WERKZEUG_STATUS)[]).filter((s) => s !== w.status)

  return (
    <>
      <PageHeader
        kicker={`Werkzeug · ${WERKZEUG_ARTEN[w.art] ?? w.art}`}
        title={
          <>
            <span className="mono">{w.nummer}</span> {w.bezeichnung}
          </>
        }
        subtitle={
          <>
            <Badge state={w.status} kind="werkzeug" led /> bei{' '}
            <Link href={`/einkauf/lieferanten/${w.partner_id}`}>{w.lieferant}</Link> · Eigentum {EIGENTUEMER[w.eigentuemer]}
            {w.status_grund ? ` · ${w.status_grund}` : ''}
          </>
        }
        actions={
          <Link className="btn" href="/einkauf/werkzeuge">
            Alle Werkzeuge
          </Link>
        }
      />

      {ld.stufe === 'ueber' && <div className="notice danger">Die Lebensdauer ist erreicht ({ld.pct} %) — Ersatz oder Überholung planen.</div>}
      {ld.stufe === 'bald' && <div className="notice warn">Über 90 % der Lebensdauer ({ld.pct} %) — Ersatz rechtzeitig anstoßen.</div>}

      <Card title="Werkzeug">
        <dl className="kv">
          <dt>Schuss</dt>
          <dd>
            <WerkzeugSchuesse zaehler={w.schuss_zaehler} lebensdauerSchuss={w.lebensdauer_schuss} />
            {ld.pct !== null ? ` · ${ld.pct} % der Lebensdauer` : ' · Lebensdauer unbekannt'}
          </dd>
          <dt>Kosten</dt>
          <dd>{w.kosten !== null ? money(w.kosten, w.waehrung) : '—'}</dd>
          <dt>Bestellung</dt>
          <dd>
            {w.po_id ? (
              <>
                <Link className="mono" href={`/einkauf/${w.po_id}`}>
                  {w.po_nummer}
                </Link>{' '}
                · {w.zeile}
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Artikel</dt>
          <dd>{w.template_id ? <Link href={`/produkte/${w.template_id}`}>{w.artikel}</Link> : '—'}</dd>
          <dt>Projekt</dt>
          <dd>{w.projekt_id ? <Link href={`/einkauf/projekte/${w.projekt_id}`}>{w.projekt}</Link> : '—'}</dd>
          <dt>Angelegt</dt>
          <dd>
            {dateTime(w.created_at)}
            {w.erstellt_von ? ` · ${w.erstellt_von}` : ''}
          </dd>
          {w.notiz && (
            <>
              <dt>Notiz</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{w.notiz}</dd>
            </>
          )}
        </dl>
      </Card>

      {darf && w.status !== 'ausgemustert' && (
        <Card title="Schüsse buchen und Status">
          <ActionForm action={werkzeugSchussBuchen.bind(null, id)}>
            <div className="row">
              <label className="field shrink">
                <span>Schüsse (negativ = Korrektur)</span>
                <input name="anzahl" inputMode="numeric" required placeholder="5.000" />
              </label>
              <label className="field">
                <span>Notiz</span>
                <input name="notiz" placeholder="z. B. Los P00042 laut Lieferant" />
              </label>
              <div className="shrink field">
                <button type="submit" className="small primary">Buchen</button>
              </div>
            </div>
          </ActionForm>
          <ActionForm action={werkzeugStatusSetzen.bind(null, id)} style={{ marginTop: 12 }}>
            <div className="row">
              <label className="field shrink">
                <span>Neuer Status</span>
                <Auswahl name="status" defaultValue={w.status === 'in_auftrag' ? 'aktiv' : statusWechsel[0]}>
                  {statusWechsel.map((s) => (
                    <option key={s} value={s}>
                      {WERKZEUG_STATUS[s]}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Grund (Pflicht beim Sperren und Ausmustern)</span>
                <input name="grund" placeholder="z. B. Kavität 2 beschädigt, in Reparatur" />
              </label>
              <div className="shrink field">
                <button type="submit" className="small">Status setzen</button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>Ausgemustert ist endgültig.</p>
          </ActionForm>
        </Card>
      )}

      {darf && (
        <Card title="Bearbeiten">
          <details>
            <summary className="small">Stammdaten ändern</summary>
            <ActionForm action={werkzeugAendern.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Bezeichnung</span>
                  <input name="bezeichnung" defaultValue={w.bezeichnung} required />
                </label>
                <label className="field">
                  <span>Art</span>
                  <Auswahl name="art" defaultValue={w.art}>
                    {Object.entries(WERKZEUG_ARTEN).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field">
                  <span>Standort (Lieferant)</span>
                  <Auswahl name="partner_id" defaultValue={w.partner_id}>
                    {lieferanten.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field shrink">
                  <span>Eigentümer</span>
                  <Auswahl name="eigentuemer" defaultValue={w.eigentuemer}>
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
                  <input name="kosten" inputMode="decimal" defaultValue={w.kosten ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Währung</span>
                  <Auswahl name="waehrung" defaultValue={w.waehrung} className="mono">
                    {waehrungen.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field shrink">
                  <span>Lebensdauer (Schuss)</span>
                  <input name="lebensdauer_schuss" inputMode="numeric" defaultValue={w.lebensdauer_schuss ?? ''} />
                </label>
                <label className="field">
                  <span>Einkaufsprojekt</span>
                  <Auswahl name="einkaufsprojekt_id" defaultValue={w.projekt_id ?? ''}>
                    <option value="">—</option>
                    {projekte.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field">
                  <span>Anderer Artikel (SKU)</span>
                  <input name="produkt" className="mono" placeholder={w.artikel ?? 'SKU, Barcode oder Name'} />
                </label>
              </div>
              <label className="field">
                <span>Notiz</span>
                <textarea name="notiz" rows={2} defaultValue={w.notiz ?? ''} />
              </label>
              <button type="submit" className="small">Speichern</button>
            </ActionForm>
          </details>
        </Card>
      )}

      <DokumenteKarte modell="werkzeug" recordId={id} titel="Zeichnungen, Fotos, Abnahmen" />
      <WiedervorlagenKarte modell="werkzeug" recordId={id} pfad={pfad} />
      <RecordComments model="werkzeug" recordId={id} path={pfad} title="Verlauf (Schüsse, Status) & Kommentare" />
    </>
  )
}
