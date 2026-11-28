import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Schublade } from '@/components/schublade'
import { Card, Empty, Stat, TableWrap } from '@/components/ui'
import { barcodeSvg } from '@/modules/shared/barcode'
import { dateTime, plural, qty } from '@/modules/shared/format'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Bausteine der Artikelseite (Entscheidungslog 2026-11-28). Produkt und
 * Variante zeigen dasselbe — ein Artikel ohne Varianten hat genau eine
 * Seite (das Produkt), und dort steht alles, was man mit ihm tun kann.
 */

interface ArtikelVariante {
  id: string
  name: string
}

/** Bestand, frei, Prognose — über alle Varianten des Artikels. */
export async function ArtikelBestand({ variantIds, uom }: { variantIds: string[]; uom: string }) {
  if (variantIds.length === 0) return null
  const [z] = await sql<{ on_hand: number; free: number; incoming: number; outgoing: number; forecasted: number }[]>`
    select coalesce(sum(on_hand_qty(v)), 0)::float as on_hand, coalesce(sum(free_to_use(v)), 0)::float as free,
           coalesce(sum(incoming_qty(v)), 0)::float as incoming, coalesce(sum(outgoing_qty(v)), 0)::float as outgoing,
           coalesce(sum(forecasted_qty(v)), 0)::float as forecasted
    from unnest(${variantIds}::uuid[]) as v`
  return (
    <div className="grid-3" style={{ marginBottom: 16 }}>
      <Stat label="Bestand" value={`${qty(z.on_hand)} ${uom}`} />
      <Stat label="Frei verfügbar" value={qty(z.free)} hint="abzüglich Reservierungen" />
      <Stat
        label="Prognose"
        value={qty(z.forecasted)}
        hint={
          <>
            {z.forecasted < 0 && (
              <>
                <span className="led warn" /> Unterdeckung ·{' '}
              </>
            )}
            {`+${qty(z.incoming)} eingehend / −${qty(z.outgoing)} ausgehend`}
          </>
        }
      />
    </div>
  )
}

export interface ArtikelAktionenProps {
  /** Aktive Varianten des Artikels — bei genau einer entfällt die Auswahl. */
  varianten: ArtikelVariante[]
  /** Suchbegriff für Listen: Artikelnummer, sonst Name. */
  suche: string
  name: string
  kaufbar: boolean
  /** Wird gefertigt und hat eine Stückliste. */
  fertigbar: boolean
  verkaufbar: boolean
  imShop: boolean
  darf: { lager: boolean; einkauf: boolean; fertigung: boolean; verkaufSehen: boolean; lagerSehen: boolean }
  bestandSetzen: (fd: FormData) => Promise<ActionResult>
  nachbestellen: (fd: FormData) => Promise<ActionResult>
  fertigen: (fd: FormData) => Promise<ActionResult>
}

function VariantenFeld({ varianten }: { varianten: ArtikelVariante[] }) {
  if (varianten.length === 1) return <input type="hidden" name="variant_id" value={varianten[0].id} />
  return (
    <label className="field">
      <span>Variante</span>
      <Auswahl name="variant_id" required defaultValue="">
        <option value="" disabled>— auswählen —</option>
        {varianten.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </Auswahl>
    </label>
  )
}

/**
 * Aktionsleiste: die Schritte, die man an einem Artikel am häufigsten
 * braucht — Bestand setzen, nachbestellen, fertigen — und die Wege zu den
 * Listen, in denen er vorkommt. Gezeigt wird nur, was der Benutzer darf und
 * was zum Artikel passt.
 */
export async function ArtikelAktionen(p: ArtikelAktionenProps) {
  if (p.varianten.length === 0) return null
  const ids = p.varianten.map((v) => v.id)
  const [lieferanten, [offen]] = await Promise.all([
    p.kaufbar && p.darf.einkauf
      ? sql<{ id: string; name: string; preis: number | null }[]>`
          select distinct on (pa.id) pa.id, pa.name, vp.price::float as preis
          from vendor_prices vp join partners pa on pa.id = vp.vendor_id and pa.active
          join product_variants pv on pv.id = any(${ids}::uuid[])
          where vp.template_id = pv.template_id and (vp.variant_id is null or vp.variant_id = any(${ids}::uuid[]))
          order by pa.id, vp.sequence, vp.min_qty`
      : Promise.resolve([]),
    sql<{ bestellungen: number; fertigung: number; bedarf: number }[]>`
      select (select count(distinct po.id)::int from purchase_order_lines l join purchase_orders po on po.id = l.order_id
               where l.variant_id = any(${ids}::uuid[]) and po.state in ('draft', 'sent', 'purchase') and l.qty > l.qty_received) as bestellungen,
             (select count(*)::int from manufacturing_orders mo
               where mo.variant_id = any(${ids}::uuid[]) and mo.state not in ('done', 'cancel')) as fertigung,
             (select count(distinct m.production_id)::int from stock_moves m
               where m.variant_id = any(${ids}::uuid[]) and m.production_id is not null
                 and m.reference = 'Komponentenverbrauch' and m.state not in ('done', 'cancel')) as bedarf`,
  ])
  const q = encodeURIComponent(p.suche)
  const eine = p.varianten.length === 1 ? p.varianten[0] : null

  return (
    <div className="artikel-aktionen no-print" role="group" aria-label="Aktionen am Artikel">
      {p.darf.lager && (
        <Schublade id="bestand-setzen" knopf="Bestand setzen" knopfKlasse="" titel={`Bestand setzen — ${p.name}`}>
          <ActionForm action={p.bestandSetzen}>
            <p className="small" style={{ marginTop: 0 }}>
              Gezählte Menge eintragen — KRNL bucht die Differenz zum Buchbestand sofort (Inventur). Für mehrere
              Artikel am Stück: <Link href="/lager/inventur">Lager → Inventur</Link>.
            </p>
            <VariantenFeld varianten={p.varianten} />
            <label className="field">
              <span>Gezählte Menge</span>
              <input type="number" name="counted_qty" step="0.001" min="0" required />
            </label>
            <button className="primary" type="submit">Bestand buchen</button>
          </ActionForm>
        </Schublade>
      )}
      {p.kaufbar && p.darf.einkauf && (
        <Schublade id="nachbestellen" knopf="Nachbestellen" knopfKlasse="" titel={`Nachbestellen — ${p.name}`}>
          <ActionForm action={p.nachbestellen}>
            <p className="small" style={{ marginTop: 0 }}>
              Legt eine Bestellung als Entwurf an — Preis aus der Lieferantenpreisliste, sonst Standardkosten.
              Bestätigt wird in der Bestellung.
            </p>
            <VariantenFeld varianten={p.varianten} />
            <label className="field">
              <span>Lieferant</span>
              <Auswahl nachladen="lieferant" name="vendor_id" required defaultValue={lieferanten[0]?.id ?? ''}>
                <option value="" disabled>— auswählen —</option>
                {lieferanten.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Auswahl>
            </label>
            <label className="field">
              <span>Menge</span>
              <input type="number" name="menge" step="1" min="1" required />
            </label>
            <button className="primary" type="submit">Bestellung anlegen</button>
          </ActionForm>
        </Schublade>
      )}
      {p.fertigbar && p.darf.fertigung && (
        <Schublade id="fertigen" knopf="Fertigen" knopfKlasse="" titel={`Fertigungsauftrag — ${p.name}`}>
          <ActionForm action={p.fertigen}>
            <p className="small" style={{ marginTop: 0 }}>Legt einen Fertigungsauftrag als Entwurf an.</p>
            <VariantenFeld varianten={p.varianten} />
            <label className="field">
              <span>Menge</span>
              <input type="number" name="qty" step="1" min="1" defaultValue={1} required />
            </label>
            <button className="primary" type="submit">Fertigungsauftrag anlegen</button>
          </ActionForm>
        </Schublade>
      )}
      {p.darf.lagerSehen && <Link className="btn" href={`/lager/bestand?q=${q}`}>Bestandsliste</Link>}
      {p.darf.lagerSehen && <Link className="btn" href="/lager/beschaffung">Meldebestand</Link>}
      {offen.bestellungen > 0 && (
        <Link className="btn" href="/einkauf">
          {plural(offen.bestellungen, 'offene Bestellung', 'offene Bestellungen')}
        </Link>
      )}
      {offen.fertigung > 0 && eine && (
        <Link className="btn" href={`/fertigung?produkt=${eine.id}`}>
          {plural(offen.fertigung, 'offener Fertigungsauftrag', 'offene Fertigungsaufträge')}
        </Link>
      )}
      {offen.bedarf > 0 && <span className="mono-label">Bedarf in {plural(offen.bedarf, 'Fertigungsauftrag', 'Fertigungsaufträgen')}</span>}
      {p.darf.verkaufSehen && (p.verkaufbar || p.imShop) && (
        <Link className="btn" href={`/verkauf/shop-verfuegbarkeit?ansicht=${p.fertigbar ? 'tastaturen' : `artikel&q=${q}`}`}>
          Shop-Verfügbarkeit
        </Link>
      )}
      <Link className="btn" href={`/produkte/zuordnung?q=${q}`}>Zuordnungen</Link>
    </div>
  )
}

/** „Verwendet in": die Stücklisten, in denen der Artikel als Position steckt. */
export async function VerwendungKarte({ variantIds }: { variantIds: string[] }) {
  if (variantIds.length === 0) return null
  const zeilen = await sql<{ bom_id: string; produkt: string; menge: number; uom: string; filter: number }[]>`
    select b.id as bom_id, pt.name as produkt, sum(l.qty)::float as menge, u.name as uom,
           (select count(*)::int from bom_line_variant_filters f join bom_lines x on x.id = f.bom_line_id
             where x.bom_id = b.id and x.component_variant_id = any(${variantIds}::uuid[])) as filter
    from bom_lines l
    join boms b on b.id = l.bom_id and b.active
    join product_templates pt on pt.id = b.template_id
    join uoms u on u.id = l.uom_id
    where l.component_variant_id = any(${variantIds}::uuid[])
    group by b.id, pt.name, u.name
    order by pt.name`
  if (zeilen.length === 0) return null
  return (
    <Card title={`Verwendet in ${plural(zeilen.length, 'Stückliste', 'Stücklisten')}`} tight>
      <TableWrap>
        <table>
          <thead>
            <tr>
              <th>Produkt</th>
              <th className="num">Menge je Stück</th>
              <th>Gilt für</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.bom_id}>
                <td><Link href={`/fertigung/stuecklisten/${z.bom_id}`}>{z.produkt}</Link></td>
                <td className="num">{qty(z.menge)} {z.uom}</td>
                <td className="small muted">{z.filter > 0 ? 'bestimmte Varianten' : 'alle Varianten'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  )
}

/** Etikett mit Barcode — und, wer im Lager schreiben darf, der Druck. */
export function EtikettKarte({
  variantId,
  code,
  darfDrucken,
  drucken,
}: {
  variantId: string
  code: string | null
  darfDrucken: boolean
  drucken: (fd: FormData) => Promise<ActionResult>
}) {
  return (
    <Card title="Etikett" actions={code && <span className="mono-label">zum Drucken scannen</span>}>
      {code ? (
        <div className="info-panel">
          <div className="display-head">
            <span>Etikett</span>
            <span>{code}</span>
          </div>
          {/* Der Barcode kommt schwarz auf transparent — er sitzt auf einem hellen
              Feld, damit die Striche in beiden Themes scannbar bleiben. */}
          <div
            style={{ textAlign: 'center', background: 'var(--display-bright)', padding: 12, borderRadius: 'var(--radius-sm)' }}
            dangerouslySetInnerHTML={{ __html: barcodeSvg(code) }}
          />
        </div>
      ) : (
        <Empty>Hinterlege eine Artikelnummer oder einen Barcode, dann erscheint hier das Etikett.</Empty>
      )}
      {code && darfDrucken && (
        <ActionForm action={drucken} linkOeffnen behalten style={{ marginTop: 12 }}>
          <input type="hidden" name="variant_id" value={variantId} />
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 140, marginBottom: 0 }}>
              <span>Anzahl</span>
              <input type="number" name="anzahl" min="1" max="500" step="1" defaultValue={1} required />
            </label>
            <div className="shrink field" style={{ marginBottom: 0 }}>
              <button type="submit">Etiketten drucken</button>
            </div>
          </div>
        </ActionForm>
      )}
    </Card>
  )
}

/** Die letzten gebuchten Lagerbewegungen des Artikels. */
export async function BewegungenKarte({ variantIds }: { variantIds: string[] }) {
  if (variantIds.length === 0) return null
  const moves = await sql<
    {
      id: string; qty_done: number; src: string; dest: string; date_done: string; reference: string | null
      picking_number: string | null; picking_id: string | null; mo_number: string | null; mo_id: string | null
      repair_number: string | null; repair_id: string | null
    }[]
  >`
    select m.id, m.qty_done, src.full_path as src, dst.full_path as dest, m.date_done, m.reference,
           p.number as picking_number, p.id as picking_id,
           mo.number as mo_number, mo.id as mo_id,
           r.number as repair_number, r.id as repair_id
    from stock_moves m
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    left join stock_pickings p on p.id = m.picking_id
    left join manufacturing_orders mo on mo.id = m.production_id
    left join repair_orders r on r.id = m.repair_id
    where m.variant_id = any(${variantIds}::uuid[]) and m.state = 'done'
    order by m.date_done desc limit 60`
  return (
    <Card title="Bewegungen" tight>
      {moves.length === 0 ? (
        <Empty>Noch keine Bewegungen.</Empty>
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Von → Nach</th>
                <th className="num">Menge</th>
                <th>Beleg</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td className="nowrap small mono">{dateTime(m.date_done)}</td>
                  <td className="small muted mono">{m.src} → {m.dest}</td>
                  <td className="num">{qty(m.qty_done)}</td>
                  <td className="mono small">
                    {m.picking_id ? (
                      <Link href={`/lager/${m.picking_id}`}>{m.picking_number}</Link>
                    ) : m.mo_id ? (
                      <Link href={`/fertigung/${m.mo_id}`}>{m.mo_number}</Link>
                    ) : m.repair_id ? (
                      <Link href={`/reparatur/${m.repair_id}`}>{m.repair_number}</Link>
                    ) : (
                      <span className="muted">{m.reference ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  )
}
