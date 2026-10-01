import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap, Zustand } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { dhlConfigured, productForCountry } from '@/modules/versand/dhl'
import { sammelMarken } from '@/modules/versand/kommissionieren'
import { gelabeltNichtAusgebucht } from '@/modules/versand/gelabelt'
import { versandbereitMitVorschlag } from '@/modules/versand/regeln'
import {
  adressePruefen,
  artikelgewichtSetzen,
  cancelLabel,
  createLabel,
  gelabelteAusbuchen,
  gewichteAusShopify,
  massLabels,
  refreshTracking,
} from './actions'
import { AuswahlAlle, AuswahlBereich, AuswahlBox, PackzettelLeiste } from './packzettel-auswahl'

export const dynamic = 'force-dynamic'

const PRODUCTS = [
  { code: 'V01PAK', label: 'DHL Paket (national)' },
  { code: 'V62KP', label: 'DHL Kleinpaket (bis 1 kg)' },
  { code: 'V54EPAK', label: 'DHL Europaket' },
  { code: 'V53WPAK', label: 'DHL Paket International' },
]

export default async function VersandPage({
  searchParams,
}: {
  searchParams: Promise<{ einzel?: string; sku?: string; land?: string; produkt?: string }>
}) {
  await requireArea('versand')
  const params = await searchParams
  const filter = {
    nurEinzelposition: params.einzel === 'on',
    sku: params.sku ?? '',
    land: params.land ?? '',
    produkt: params.produkt ?? '',
  }
  const gefiltert = Object.values(filter).some(Boolean)
  const ready = await versandbereitMitVorschlag(filter)
  // Kommissionier-Marken (0091): Zettel gedruckt, wird gesammelt, kommissioniert.
  const marken = await sammelMarken(ready.map((r) => r.picking_id))
  // Kunde als Weg zum Kontakt (Betreiber 2026-10-01): die Sicht
  // shipping_ready trägt nur den Namen — die Partner-IDs kommen in EINER
  // Abfrage über alle Zeilen dazu, nicht je Zeile.
  const partnerJeLieferung = new Map(
    (ready.length === 0
      ? []
      : await sql<{ id: string; partner_id: string | null }[]>`
          select id, partner_id from stock_pickings
          where id = any(${ready.map((r) => r.picking_id)}::uuid[])`
    ).map((p) => [p.id, p.partner_id]),
  )
  // Live gezählt: was noch auf Ware wartet, erscheint von selbst, sobald
  // Bestand gebucht ist (Live-Reservierung, Migration 0086).
  const [{ wartend }] = await sql<{ wartend: number }[]>`
    select count(*)::int as wartend
    from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
    where ot.kind = 'delivery' and p.state in ('waiting', 'confirmed')`
  // Label da, Ware nicht ausgebucht (Entscheidungslog 2026-10-01): aus der
  // Zeit, als Ausbuchen ein Haken war, oder bewusst „nur Label".
  const gelabelt = await gelabeltNichtAusgebucht()
  const gelabeltIds = new Set(gelabelt.map((g) => g.picking_id))
  // Artikel ohne Gewicht in versandbereiten Lieferungen (2026-10-01): aus
  // Shopify nicht übernommen — ohne Gewicht stimmen Paketgewicht und
  // DHL-Produkt nicht. Hier direkt setzen oder aus Shopify holen.
  const ohneGewicht = await sql<{ variant_id: string; artikel: string; sku: string | null; lieferungen: number }[]>`
    select pv.id as variant_id, variant_display_name(pv.id) as artikel, pv.sku,
           count(distinct p.id)::int as lieferungen
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    join stock_moves m on m.picking_id = p.id and m.state <> 'cancel'
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where p.state in ('assigned', 'confirmed', 'waiting') and coalesce(pt.weight_g, 0) <= 0
    group by pv.id, pv.sku
    order by count(distinct p.id) desc, 2
    limit 30`

  const shipments = await sql<
    {
      id: string
      shipment_number: string
      state: string
      tracking_url: string
      hat_label: boolean
      dhl_product: string
      created_at: string
      picking_number: string | null
      picking_id: string | null
      repair_id: string | null
      repair_number: string | null
      customer: string | null
      customer_id: string | null
      shopify_fulfillment_id: string | null
      last_event: { description?: string } | null
      ersatz_moeglich: boolean
    }[]
  >`
    select s.id, s.shipment_number, s.state, s.tracking_url, s.dhl_product,
           (s.label_pdf is not null or s.label_path is not null) as hat_label,
           s.created_at, p.number as picking_number, p.id as picking_id,
           r.id as repair_id, r.number as repair_number,
           coalesce(part.name, rpart.name) as customer, coalesce(part.id, rpart.id) as customer_id,
           s.shopify_fulfillment_id,
           s.last_tracking_event as last_event,
           -- Ersatz-Label (2026-10-01): jüngste stornierte Sendung einer
           -- ausgebuchten Lieferung, die keine gültige Sendung mehr hat.
           (s.state = 'cancelled' and p.state = 'done'
            and not exists (select 1 from shipments x
                            where x.picking_id = s.picking_id
                              and (x.state not in ('cancelled', 'failure') or x.created_at > s.created_at))
           ) as ersatz_moeglich
    from shipments s
    -- Eine Sendung gehört zu einer Lieferung ODER zu einer Reparatur (0081).
    left join stock_pickings p on p.id = s.picking_id
    left join partners part on part.id = p.partner_id
    left join repair_orders r on r.id = s.repair_order_id
    left join partners rpart on rpart.id = r.partner_id
    order by s.created_at desc
    limit 60`

  const configured = dhlConfigured()

  return (
    <>
      <PageHeader
        title="Versand"
        subtitle="Fertige Aufträge etikettieren, Sendungen verfolgen"
        actions={
          <>
            {/* Verbindungszustand des Geräts: Leuchte plus Wort, in beiden Richtungen sichtbar. */}
            <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span className={configured ? 'led ok' : 'led warn'} />
              <span className="mono-label">
                {configured ? 'DHL verbunden' : 'DHL nicht konfiguriert'}
              </span>
            </span>
            <Link className="btn" href="/kommissionieren">Kommissionieren</Link>
            <Link className="btn" href="/versand/retouren">Retourenlabels</Link>
            <ActionButton action={refreshTracking}>Tracking aktualisieren</ActionButton>
          </>
        }
      />

      {!configured && (
        <div className="notice warn">
          DHL ist noch nicht konfiguriert. Hinterlege API-Key, GKP-Zugangsdaten und Abrechnungsnummer
          als Umgebungsvariablen (siehe <code className="mono">.env.example</code>), dann lassen sich hier Labels erzeugen.
        </div>
      )}

      {gelabelt.length > 0 && (
        <div className="notice warn">
          <ActionForm action={gelabelteAusbuchen}>
            <div className="row" style={{ alignItems: 'center', gap: 12 }}>
              <div>
                {gelabelt.length} Lieferung(en) haben ein Label, sind aber noch nicht ausgebucht — Lager
                und Shopify wissen nichts vom Versand (
                {gelabelt.slice(0, 5).map((g, i) => (
                  <span key={g.picking_id}>
                    {i > 0 && ', '}
                    <Link className="mono" href={`/lager/${g.picking_id}`}>{g.picking_number}</Link>
                  </span>
                ))}
                {gelabelt.length > 5 ? ' …' : ''}).
              </div>
              <div className="shrink">
                <button className="primary small" type="submit">Alle ausbuchen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      )}

      {ohneGewicht.length > 0 && (
        <Card title={`Gewichte fehlen (${ohneGewicht.length}${ohneGewicht.length === 30 ? '+' : ''})`} tight>
          <div style={{ padding: '10px 12px' }}>
            <p className="muted small" style={{ marginTop: 0 }}>
              Diese Artikel in offenen Lieferungen haben kein Gewicht — Paketgewicht und DHL-Produkt
              stimmen sonst nicht. Gewicht je Stück in Gramm setzen (gilt für den Artikel) oder aus
              Shopify übernehmen (nur wo KRNL noch keines hat).
            </p>
            <ActionForm action={gewichteAusShopify}>
              <button className="small" type="submit">Gewichte aus Shopify übernehmen</button>
            </ActionForm>
          </div>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>SKU</th>
                  <th className="num">Lieferungen</th>
                  <th style={{ width: 240 }}>Gewicht je Stück</th>
                </tr>
              </thead>
              <tbody>
                {ohneGewicht.map((a) => (
                  <tr key={a.variant_id}>
                    <td><Link href={`/produkte/variante/${a.variant_id}`}>{a.artikel}</Link></td>
                    <td className="mono small">{a.sku ?? '—'}</td>
                    <td className="num">{a.lieferungen}</td>
                    <td>
                      <ActionForm action={artikelgewichtSetzen}>
                        <input type="hidden" name="variant_id" value={a.variant_id} />
                        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                          <div className="shrink" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              name="weight_g"
                              inputMode="numeric"
                              required
                              aria-label={`Gewicht von ${a.artikel} in Gramm`}
                              style={{ width: 84 }}
                            />
                            <span className="mono-label">g</span>
                          </div>
                          <div className="shrink">
                            <button className="small" type="submit">Speichern</button>
                          </div>
                        </div>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {wartend > 0 && (
        <div className="notice">
          {wartend} Lieferung(en) warten auf Ware. Sie erscheinen hier von selbst, sobald Bestand
          gebucht ist (Wareneingang, Inventur, Fertigmeldung, Storno) —{' '}
          <Link href="/lager?art=delivery">Warenausgänge ansehen</Link>.
        </div>
      )}

      <AuswahlBereich ids={ready.map((r) => r.picking_id)}>
      <Card title={`Versandbereit (${ready.length})`} tight>
        {/* Filter als GET-Formular: die Adresszeile IST der Filterzustand,
            und der Massendruck druckt exakt diese Liste. */}
        <form method="get" className="row" style={{ padding: '10px 12px 0', alignItems: 'flex-end' }}>
          <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" name="einzel" defaultChecked={filter.nurEinzelposition} />
            <span>nur Einzelposition</span>
          </label>
          <label className="field shrink">
            <span>SKU enthält</span>
            <input className="mono" name="sku" defaultValue={filter.sku} placeholder="z. B. KC-" style={{ width: 120 }} />
          </label>
          <label className="field shrink">
            <span>Land</span>
            <input className="mono" name="land" defaultValue={filter.land} placeholder="DE" maxLength={2} style={{ width: 60 }} />
          </label>
          <label className="field shrink">
            <span>Produkt (laut Regel)</span>
            <select name="produkt" className="mono" defaultValue={filter.produkt} style={{ width: 130 }}>
              <option value="">alle</option>
              {PRODUCTS.map((p) => (
                <option key={p.code} value={p.code}>{p.code}</option>
              ))}
            </select>
          </label>
          <div className="shrink field">
            <button className="small" type="submit">Filtern</button>
          </div>
          {gefiltert && (
            <div className="shrink field">
              <Link className="btn small" href="/versand">Zurücksetzen</Link>
            </div>
          )}
        </form>
        {ready.length === 0 ? (
          <Empty>
            {gefiltert
              ? 'Kein Treffer für diese Filter.'
              : 'Nichts versandbereit. Lieferungen erscheinen hier, sobald sie reserviert sind und keine Fertigungsaufträge mehr offen sind.'}
          </Empty>
        ) : (
          <>
          <PackzettelLeiste />
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <AuswahlAlle />
                  </th>
                  <th>Lieferung</th>
                  <th>Auftrag</th>
                  <th>Kunde</th>
                  <th>Ziel</th>
                  <th className="num">Gewicht</th>
                  <th style={{ width: 360 }}>Label</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((r) => {
                  const vorschlag = r.vorschlag
                  const produktVorschlag =
                    vorschlag?.product ?? productForCountry(r.ship_country_code)
                  const marke = marken.get(r.picking_id)
                  return (
                  <tr key={r.picking_id}>
                    <td>
                      <AuswahlBox id={r.picking_id} label={r.picking_number} />
                    </td>
                    <td className="mono">
                      <Link href={`/lager/${r.picking_id}`}>{r.picking_number}</Link>{' '}
                      <a
                        className="small"
                        href={`/lager/${r.picking_id}/druck`}
                        target="_blank"
                        rel="noopener"
                        title="Packzettel drucken (Versand-Barcode + Positionen)"
                      >
                        🖨
                      </a>
                      {marke && (marke.packzettelGedrucktAm || marke.sammler || marke.kommissioniertAm) && (
                        <div className="actions" style={{ gap: 6, marginTop: 2 }}>
                          {marke.kommissioniertAm ? (
                            <Zustand ton="ok">kommissioniert</Zustand>
                          ) : marke.sammler ? (
                            <Zustand ton="on">sammelt: {marke.sammler}</Zustand>
                          ) : null}
                          {marke.packzettelGedrucktAm && <Zustand ton="off">Zettel gedruckt</Zustand>}
                        </div>
                      )}
                    </td>
                    <td className="mono small">
                      {r.sales_order_id ? (
                        <Link href={`/verkauf/${r.sales_order_id}`}>
                          {r.shopify_order_name ?? r.sales_order_number}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {r.customer_name && partnerJeLieferung.get(r.picking_id) ? (
                        <Link href={`/kontakte/${partnerJeLieferung.get(r.picking_id)}`}>
                          {r.customer_name}
                        </Link>
                      ) : (
                        (r.customer_name ?? '—')
                      )}
                    </td>
                    <td className="small">
                      {/* PLZ und Ländercode sind Codes, der Ort bleibt Fließtext. */}
                      <span className="mono">{r.ship_zip}</span> {r.ship_city}{' '}
                      <span className="mono">{r.ship_country_code}</span>
                      {/* Vor dem Label (2026-10-01): DHL prüft denselben Request
                          mit validate=true — kein Label, keine Buchung. */}
                      {configured && Number(r.shipment_count) === 0 && (
                        <div style={{ marginTop: 4 }}>
                          <ActionButton
                            className="small"
                            action={adressePruefen.bind(null, r.picking_id)}
                            title="DHL prüft die Sendung samt Adresse, ohne ein Label zu erstellen"
                          >
                            Adresse prüfen
                          </ActionButton>
                        </div>
                      )}
                    </td>
                    <td className="num nowrap">
                      {qty((vorschlag?.versandgewichtG ?? Number(r.weight_g)) / 1000)} kg
                      {vorschlag?.kartonage && (
                        <div className="muted small">
                          inkl. {vorschlag.kartonage.name}
                        </div>
                      )}
                    </td>
                    <td>
                      {Number(r.shipment_count) > 0 ? (
                        <div className="actions" style={{ gap: 6 }}>
                          {/* Direkt zum PDF — die Route löst die jüngste Sendung
                              dieser Lieferung mit Label auf. */}
                          <a
                            className="badge success"
                            href={`/api/label/lieferung/${r.picking_id}`}
                            target="_blank"
                            rel="noopener"
                            title="Label-PDF öffnen"
                          >
                            Label öffnen
                          </a>
                          {gelabeltIds.has(r.picking_id) && (
                            <ActionForm action={gelabelteAusbuchen}>
                              <input type="hidden" name="ids" value={r.picking_id} />
                              <button
                                className="small"
                                type="submit"
                                title="Warenausgang buchen, Kartonage verbrauchen, Sendung an Shopify melden"
                              >
                                Ausbuchen
                              </button>
                            </ActionForm>
                          )}
                        </div>
                      ) : (
                        <ActionForm action={createLabel.bind(null, r.picking_id)}>
                          <div className="row" style={{ gap: 6 }}>
                            {/* Einheit sichtbar machen statt nur im title-Attribut. */}
                            <div
                              className="shrink"
                              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <input
                                type="number"
                                name="weight_g"
                                aria-label="Gewicht in Gramm"
                                defaultValue={Math.max(
                                  vorschlag?.versandgewichtG ?? Number(r.weight_g),
                                  1,
                                )}
                                min={1}
                                style={{ width: 84 }}
                              />
                              <span className="mono-label">g</span>
                            </div>
                            <div className="shrink">
                              <select
                                name="dhl_product"
                                className="mono"
                                aria-label="DHL-Produkt"
                                defaultValue=""
                                style={{ width: 132 }}
                              >
                                <option value="">{`Regel: ${produktVorschlag}`}</option>
                                {PRODUCTS.map((p) => (
                                  <option key={p.code} value={p.code}>{p.code} — {p.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="shrink">
                              {/* Zeilenaktion bleibt neutral — Orange ist der Kopfzeile vorbehalten. */}
                              <button
                                className="small"
                                type="submit"
                                disabled={!configured}
                                title="Label erstellen und ausbuchen: Warenausgang, Kartonage, Shopify-Meldung"
                              >
                                Label erstellen
                              </button>
                            </div>
                            {/* Das Label bucht aus (2026-10-01) — der Haken ist die Ausnahme. */}
                            <label
                              className="shrink small muted"
                              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                              title="Nur das Label drucken — Warenausgang und Shopify-Meldung später über „Ausbuchen“"
                            >
                              <input type="checkbox" name="nicht_ausbuchen" />
                              <span>nur Label</span>
                            </label>
                          </div>
                          {(vorschlag?.productRegel || vorschlag?.insuredValue || vorschlag?.kartonage) && (
                            <div className="muted small" style={{ marginTop: 4 }}>
                              {[
                                vorschlag.productRegel && `Regel: ${vorschlag.productRegel}`,
                                vorschlag.kartonage && `Kartonage: ${vorschlag.kartonage.name}`,
                                vorschlag.insuredValue &&
                                  `Versicherung ${vorschlag.insuredValue.toFixed(2)} € (${vorschlag.insuranceRegel})`,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          )}
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          </>
        )}
        {ready.some((r) => Number(r.shipment_count) === 0) && (
          <div style={{ padding: '0 12px 12px' }}>
            {/* Der Massendruck übernimmt die Filter als versteckte Felder —
                gedruckt wird exakt die Liste oben, nach Regelvorschlag. */}
            <ActionForm action={massLabels}>
              <input type="hidden" name="einzel" value={filter.nurEinzelposition ? 'on' : ''} />
              <input type="hidden" name="sku" value={filter.sku} />
              <input type="hidden" name="land" value={filter.land} />
              <input type="hidden" name="produkt" value={filter.produkt} />
              <div className="row" style={{ alignItems: 'center', gap: 12 }}>
                <div className="shrink">
                  <button className="primary" type="submit" disabled={!configured}>
                    Massendruck: {Math.min(ready.filter((r) => Number(r.shipment_count) === 0).length, 25)} Labels nach Regeln
                  </button>
                </div>
                {/* Jedes Label bucht aus (2026-10-01) — der Haken ist die Ausnahme. */}
                <label className="shrink" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" name="nicht_ausbuchen" />
                  <span>nicht ausbuchen — nur Labels drucken (sonst: Warenausgang + Shopify-Meldung)</span>
                </label>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>
      </AuswahlBereich>

      <Card title="Sendungen" tight>
        {shipments.length === 0 ? (
          <Empty>Noch keine Sendungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendungsnummer</th>
                  <th>Lieferung</th>
                  <th>Kunde</th>
                  <th>Status</th>
                  <th>Shopify</th>
                  <th>Erstellt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <a href={s.tracking_url} target="_blank" rel="noreferrer">{s.shipment_number}</a>
                      {s.last_event?.description && (
                        <div className="muted small">{s.last_event.description}</div>
                      )}
                    </td>
                    <td className="mono small">
                      {s.picking_id ? (
                        <Link href={`/lager/${s.picking_id}`}>{s.picking_number}</Link>
                      ) : s.repair_id ? (
                        <Link href={`/reparatur/${s.repair_id}`} title="Rückversand einer Reparatur">
                          {s.repair_number}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {s.customer && s.customer_id ? (
                        <Link href={`/kontakte/${s.customer_id}`}>{s.customer}</Link>
                      ) : (
                        (s.customer ?? '—')
                      )}
                    </td>
                    <td><Badge state={s.state} kind="shipment" /></td>
                    <td>
                      {/* Beide Zustände sind beschriftet — „nicht gemeldet" ist auch ein Zustand. */}
                      <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span className={s.shopify_fulfillment_id ? 'led ok' : 'led off'} />
                        <span className="mono small">
                          {s.shopify_fulfillment_id ? 'gemeldet' : 'offen'}
                        </span>
                      </span>
                    </td>
                    <td className="mono nowrap small">{dateTime(s.created_at)}</td>
                    <td className="num">
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        {s.hat_label && (
                          <a className="btn small" href={`/api/label/${s.id}`} target="_blank" rel="noopener">
                            Label
                          </a>
                        )}
                        {s.ersatz_moeglich && s.picking_id && (
                          <ActionForm action={createLabel.bind(null, s.picking_id)}>
                            <button
                              className="small"
                              type="submit"
                              disabled={!configured}
                              title="Die Lieferung ist schon ausgebucht — neues Label nach Regel, die neue Sendungsnummer geht an Shopify"
                            >
                              Ersatz-Label
                            </button>
                          </ActionForm>
                        )}
                        {s.state === 'created' && (
                          <ActionButton
                            className="small danger"
                            action={cancelLabel.bind(null, s.id)}
                            confirm="Sendung bei DHL stornieren? Das geht nur vor dem Tagesabschluss."
                          >
                            Stornieren
                          </ActionButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
