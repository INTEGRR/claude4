import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { DokumenteKarte } from '@/components/dokumente'
import { WiedervorlagenKarte } from '@/components/mail-threads'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { KOSTEN_ARTEN, type KostenArt, SENDUNG_MODI, type SendungModus, zollsatz } from '@/modules/einkauf/sendungen'
import { date, dateTime, money } from '@/modules/shared/format'
import {
  pflichtdokumenteNachfragen,
  sendungAbrechnen,
  sendungAendern,
  sendungAnkommen,
  sendungBestellungLoesen,
  sendungBestellungZuordnen,
  sendungKostenEntfernen,
  sendungKostenErfassen,
  sendungSchaetzen,
  sendungStornieren,
  sendungVerschiffen,
  sendungVerteilen,
  sendungVerzollen,
  sendungZollErfassen,
} from '../actions'
import { Auswahl } from '@/components/auswahl'
import { kurzLieferant } from '@/app/(erp)/kurzanlage'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Eine Eingangssendung (0108): Ablauf (verschiffen, verzollen, ankommen,
 * abrechnen, stornieren), Bestellungen und ihre Wareneingänge, Kosten
 * (Schätzung → Rechnung), Verteilung als Landed Costs, Zollbescheid mit EUSt
 * getrennt, fehlende Pflichtdokumente mit Nachfrage, Dokumente,
 * Wiedervorlagen, Prozess und Verlauf.
 */
export default async function SendungPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const pfad = `/einkauf/sendungen/${id}`

  const [s] = await sql<
    {
      id: string
      nummer: string
      bezeichnung: string | null
      status: string
      modus: SendungModus
      spediteur_id: string | null
      spediteur: string | null
      traeger: string | null
      hbl_awb: string | null
      container: string | null
      tracking_url: string | null
      etd: string | null
      eta: string | null
      verschifft_am: string | null
      verzollt_am: string | null
      angekommen_am: string | null
      abgerechnet_am: string | null
      gewicht_kg: number | null
      volumen_cbm: number | null
      packstuecke: number | null
      zustaendig_id: string | null
      zustaendig: string | null
      storno_grund: string | null
      notiz: string | null
      erstellt_von: string | null
    }[]
  >`
    select s.id, s.nummer, s.bezeichnung, s.status::text as status, s.modus, s.spediteur_id, sp.name as spediteur,
           s.traeger, s.hbl_awb, s.container, s.tracking_url, s.etd::text as etd, s.eta::text as eta,
           s.verschifft_am::text as verschifft_am, s.verzollt_am::text as verzollt_am, s.angekommen_am::text as angekommen_am,
           s.abgerechnet_am::text as abgerechnet_am, s.gewicht_kg::float as gewicht_kg, s.volumen_cbm::float as volumen_cbm,
           s.packstuecke, s.zustaendig_id, u.name as zustaendig, s.storno_grund, s.notiz, s.erstellt_von
    from eingangs_sendungen s
    left join partners sp on sp.id = s.spediteur_id
    left join users u on u.id = s.zustaendig_id
    where s.id = ${id}`
  if (!s) notFound()

  const [bestellungen, eingaenge, kosten, verteilung, zoll, fehlend, kandidaten, partner, rechnungen, dokumente, nutzer] =
    await Promise.all([
      sql<{ id: string; number: string; partner_id: string; lieferant: string; verschifft_am: string | null; eta: string | null; incoterm: string | null }[]>`
        select po.id, po.number, pa.id as partner_id, pa.name as lieferant, po.verschifft_am::text as verschifft_am,
               coalesce(po.eta_confirmed, po.expected_arrival::date)::text as eta, po.incoterm_code as incoterm
        from eingangs_sendung_bestellungen b
        join purchase_orders po on po.id = b.purchase_order_id
        join partners pa on pa.id = po.vendor_id
        where b.sendung_id = ${id}
        order by po.number`,
      sql<{ id: string; number: string; state: string; origin_id: string | null; date_done: string | null }[]>`
        select id, number, state::text as state, origin_id, date_done::text as date_done
        from stock_pickings where eingangs_sendung_id = ${id} order by number`,
      sql<
        {
          id: string
          art: KostenArt
          betrag: number
          waehrung: string
          kurs: number | null
          belegdatum: string | null
          schaetzung: boolean
          aus_zollbescheid: boolean
          partner_id: string | null
          partner: string | null
          vendor_bill_id: string | null
          rechnung: string | null
          ersetzt_durch_id: string | null
          verteilt_am: string | null
          storniert_am: string | null
          notiz: string | null
        }[]
      >`
        select k.id, k.art, k.betrag::float as betrag, k.waehrung, k.kurs::float as kurs, k.belegdatum::text as belegdatum,
               k.schaetzung, k.aus_zollbescheid, k.partner_id, pa.name as partner, k.vendor_bill_id, vb.number as rechnung,
               k.ersetzt_durch_id, k.verteilt_am::text as verteilt_am, k.storniert_am::text as storniert_am, k.notiz
        from sendung_kosten k
        left join partners pa on pa.id = k.partner_id
        left join vendor_bills vb on vb.id = k.vendor_bill_id
        where k.sendung_id = ${id}
        order by k.storniert_am nulls first, k.created_at`,
      sql<{ id: string; number: string; picking_id: string; picking: string; art: KostenArt; amount: number; currency: string; basis: string; is_estimate: boolean; state: string }[]>`
        select l.id, l.number, l.picking_id, p.number as picking, k.art, l.amount::float as amount, l.currency,
               l.basis::text as basis, l.is_estimate, l.state
        from landed_costs l
        join sendung_kosten k on k.id = l.sendung_kosten_id
        join stock_pickings p on p.id = l.picking_id
        where k.sendung_id = ${id}
        order by l.state = 'cancel', k.art, p.number`,
      sql<{ id: string; hs_code: string; zollwert_eur: number; zoll_eur: number; eust_eur: number; po_id: string | null; po: string | null }[]>`
        select z.id, z.hs_code, z.zollwert_eur::float as zollwert_eur, z.zoll_eur::float as zoll_eur, z.eust_eur::float as eust_eur,
               po.id as po_id, po.number as po
        from sendung_zoll z left join purchase_orders po on po.id = z.purchase_order_id
        where z.sendung_id = ${id} order by z.hs_code`,
      // Fehlende Pflichtdokumente der Sendung UND ihrer Bestellungen.
      sql<{ modell: string; record_id: string; nummer: string; bezeichnung: string; faellig_am: string | null }[]>`
        select d.modell, d.record_id, d.nummer, d.bezeichnung, d.faellig_am::text as faellig_am
        from einkauf_offene_pflichtdokumente d
        where (d.modell = 'eingangs_sendung' and d.record_id = ${id})
           or (d.modell = 'purchase_order'
               and d.record_id in (select purchase_order_id from eingangs_sendung_bestellungen where sendung_id = ${id}))
        order by d.modell, d.nummer, d.bezeichnung`,
      sql<{ id: string; label: string }[]>`
        select po.id, po.number || ' · ' || pa.name as label
        from purchase_orders po join partners pa on pa.id = po.vendor_id
        where po.state = 'purchase'
          and not exists (select 1 from eingangs_sendung_bestellungen b where b.sendung_id = ${id} and b.purchase_order_id = po.id)
          and exists (select 1 from stock_pickings sp
                      where sp.origin_model = 'purchase_order' and sp.origin_id = po.id and sp.eingangs_sendung_id is null
                        and sp.state <> 'cancel')
        order by po.created_at desc limit 100`,
      sql<{ id: string; name: string }[]>`select id, name from partners where is_vendor and active order by lower(name) limit 500`,
      sql<{ id: string; label: string }[]>`
        select vb.id, vb.number || ' · ' || pa.name || coalesce(' · ' || vb.vendor_bill_reference, '') as label
        from vendor_bills vb join partners pa on pa.id = vb.vendor_id
        where vb.state <> 'cancel' and (vb.vendor_id = ${s.spediteur_id ?? null}::uuid or vb.purchase_order_id is null)
        order by vb.created_at desc limit 50`,
      sql<{ id: string; name: string }[]>`
        select d.id, d.name from dokumente d join dokument_verweise v on v.dokument_id = d.id
        where v.modell = 'eingangs_sendung' and v.record_id = ${id} order by d.created_at desc`,
      sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
    ])

  const heute = new Date().toISOString().slice(0, 10)
  const aktiv = kosten.filter((k) => !k.storniert_am && !k.ersetzt_durch_id)
  const offenVerteilen = aktiv.filter((k) => k.art !== 'eust' && !k.verteilt_am)
  const eingaengeOffen = eingaenge.filter((e) => e.state !== 'done' && e.state !== 'cancel')
  const eingaengeGebucht = eingaenge.filter((e) => e.state === 'done')
  const gebucht = verteilung.filter((v) => v.state === 'posted')
  const summeVerteilt = gebucht.reduce((a, v) => a + v.amount, 0)
  const eust = aktiv.filter((k) => k.art === 'eust').reduce((a, k) => a + k.betrag, 0)
  const schaetzungen = aktiv.filter((k) => k.schaetzung)
  const ohneEingang = bestellungen.filter((b) => !eingaenge.some((e) => e.origin_id === b.id))
  const laufend = ['geplant', 'verschifft', 'verzollt', 'angekommen'].includes(s.status)
  const fehlendSendung = fehlend.filter((f) => f.modell === 'eingangs_sendung')
  const fehlendBestellungen = [...new Map(fehlend.filter((f) => f.modell === 'purchase_order').map((f) => [f.record_id, f.nummer])).entries()]

  return (
    <>
      <PageHeader
        kicker="Eingangssendung"
        title={
          <>
            <span className="mono">{s.nummer}</span>
            {s.bezeichnung ? ` ${s.bezeichnung}` : ''}
          </>
        }
        subtitle={
          <>
            <Badge state={s.status} kind="eingangs_sendung" /> {SENDUNG_MODI[s.modus]}
            {s.spediteur_id && (
              <>
                {' · '}
                <Link href={`/einkauf/lieferanten/${s.spediteur_id}`}>{s.spediteur}</Link>
              </>
            )}
            {s.traeger ? ` · ${s.traeger}` : ''}
            {s.hbl_awb ? ` · ${s.hbl_awb}` : ''}
          </>
        }
        actions={
          <Link className="btn" href="/einkauf/sendungen">
            Alle Sendungen
          </Link>
        }
      />

      {s.status === 'storniert' && <div className="notice warn">Storniert: {s.storno_grund}</div>}
      {s.status === 'angekommen' && eingaengeOffen.length > 0 && (
        <div className="notice info">
          Angekommen — jetzt die Wareneingänge buchen:{' '}
          {eingaengeOffen.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ', '}
              <Link className="mono" href={`/lager/${e.id}`}>
                {e.number}
              </Link>
            </span>
          ))}
          . Danach abrechnen.
        </div>
      )}

      {darf && laufend && (
        <Card title="Ablauf">
          {s.status === 'geplant' && (
            <ActionForm action={sendungVerschiffen.bind(null, id)} style={{ marginBottom: 12 }}>
              <div className="row">
                <label className="field shrink">
                  <span>Verschifft am</span>
                  <input type="date" name="verschifft_am" defaultValue={heute} />
                </label>
                <label className="field shrink">
                  <span>ETA</span>
                  <input type="date" name="eta" defaultValue={s.eta ?? ''} />
                </label>
                <label className="field">
                  <span>HBL / AWB</span>
                  <input name="hbl_awb" className="mono" defaultValue={s.hbl_awb ?? ''} />
                </label>
                <label className="field">
                  <span>Container</span>
                  <input name="container" className="mono" defaultValue={s.container ?? ''} />
                </label>
                <div className="field shrink">
                  <button type="submit" className="primary small">
                    Verschifft
                  </button>
                </div>
              </div>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Der Tag geht an alle Bestellungen der Sendung — Zahlplan-Raten „bei Verschiffung" werden fällig.
              </p>
            </ActionForm>
          )}
          {s.status === 'verschifft' && (
            <div className="row" style={{ marginBottom: 12 }}>
              <ActionForm action={sendungVerzollen.bind(null, id)}>
                <div className="row">
                  <label className="field shrink">
                    <span>Verzollt am</span>
                    <input type="date" name="verzollt_am" defaultValue={heute} />
                  </label>
                  <div className="field shrink">
                    <button type="submit" className="small primary">
                      Verzollt
                    </button>
                  </div>
                </div>
              </ActionForm>
            </div>
          )}
          {(s.status === 'verschifft' || s.status === 'verzollt') && (
            <ActionForm action={sendungAnkommen.bind(null, id)} style={{ marginBottom: 12 }}>
              <div className="row">
                <label className="field shrink">
                  <span>Angekommen am</span>
                  <input type="date" name="angekommen_am" defaultValue={heute} />
                </label>
                <div className="field shrink">
                  <button type="submit" className="small primary">
                    Angekommen
                  </button>
                </div>
              </div>
              {s.status === 'verschifft' && (
                <p className="small muted" style={{ margin: '4px 0 0' }}>
                  Express: der Kurier verzollt selbst — direkt „Angekommen".
                </p>
              )}
            </ActionForm>
          )}
          {s.status === 'angekommen' && (
            <div style={{ marginBottom: 12 }}>
              <ActionButton
                className="primary"
                action={sendungAbrechnen.bind(null, id)}
                disabled={eingaengeOffen.length > 0 || eingaengeGebucht.length === 0}
                confirm={`${s.nummer} abrechnen? Die offenen Kosten werden als Landed Costs auf die Wareneingänge gebucht.`}
              >
                Abrechnen
              </ActionButton>
              <span className="small muted" style={{ marginLeft: 8 }}>
                {eingaengeOffen.length > 0
                  ? 'Erst alle Wareneingänge buchen.'
                  : schaetzungen.length > 0
                    ? `Noch geschätzt: ${[...new Set(schaetzungen.map((k) => KOSTEN_ARTEN[k.art]))].join(', ')} — erst Rechnung bzw. Zollbescheid erfassen.`
                    : 'Verteilt die restlichen Kosten und schließt die Sendung ab.'}
              </span>
            </div>
          )}
          {(s.status === 'geplant' || s.status === 'verschifft') && (
            <details>
              <summary className="small">Stornieren</summary>
              <ActionForm action={sendungStornieren.bind(null, id)} style={{ marginTop: 8 }}>
                <div className="row">
                  <label className="field" style={{ flex: 3 }}>
                    <span>Grund</span>
                    <input name="grund" required minLength={3} placeholder="z. B. Buchung beim Spediteur entfallen" />
                  </label>
                  <div className="field shrink">
                    <button type="submit" className="small">
                      Sendung stornieren
                    </button>
                  </div>
                </div>
              </ActionForm>
            </details>
          )}
        </Card>
      )}

      <Card title="Sendung">
        <dl className="kv">
          <dt>Modus</dt>
          <dd>{SENDUNG_MODI[s.modus]}</dd>
          <dt>Spediteur / Träger</dt>
          <dd>
            {s.spediteur_id ? <Link href={`/einkauf/lieferanten/${s.spediteur_id}`}>{s.spediteur}</Link> : '—'}
            {s.traeger ? ` · ${s.traeger}` : ''}
          </dd>
          <dt>HBL / AWB · Container</dt>
          <dd className="mono">
            {s.tracking_url ? (
              <a href={s.tracking_url} target="_blank" rel="noreferrer">
                {s.hbl_awb ?? 'Sendung verfolgen'}
              </a>
            ) : (
              (s.hbl_awb ?? '—')
            )}
            {s.container ? ` · ${s.container}` : ''}
          </dd>
          <dt>ETD / ETA</dt>
          <dd>
            {date(s.etd)} → {date(s.eta)}
          </dd>
          <dt>Verschifft · verzollt · angekommen</dt>
          <dd>
            {date(s.verschifft_am)} · {date(s.verzollt_am)} · {date(s.angekommen_am)}
            {s.abgerechnet_am ? ` · abgerechnet ${dateTime(s.abgerechnet_am)}` : ''}
          </dd>
          <dt>Gewicht · Volumen · Packstücke</dt>
          <dd>
            {s.gewicht_kg !== null ? `${s.gewicht_kg.toLocaleString('de-DE')} kg` : '—'} ·{' '}
            {s.volumen_cbm !== null ? `${s.volumen_cbm.toLocaleString('de-DE')} cbm` : '—'} · {s.packstuecke ?? '—'}
          </dd>
          <dt>Zuständig</dt>
          <dd>
            {s.zustaendig ?? '—'}
            {s.erstellt_von ? ` · angelegt von ${s.erstellt_von}` : ''}
          </dd>
          {s.notiz && (
            <>
              <dt>Notiz</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{s.notiz}</dd>
            </>
          )}
        </dl>
        {darf && s.status !== 'storniert' && (
          <details style={{ marginTop: 10 }}>
            <summary className="small">Daten nachtragen</summary>
            <ActionForm action={sendungAendern.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Bezeichnung</span>
                  <input name="bezeichnung" defaultValue={s.bezeichnung ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Modus</span>
                  <Auswahl name="modus" defaultValue={s.modus}>
                    {Object.entries(SENDUNG_MODI).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field">
                  <span>Spediteur</span>
                  <Auswahl kurzanlage={kurzLieferant(user, 'Spediteur')} name="spediteur_id" defaultValue={s.spediteur_id ?? ''}>
                    <option value="">—</option>
                    {partner.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Auswahl>
                </label>
                <label className="field">
                  <span>Träger</span>
                  <input name="traeger" defaultValue={s.traeger ?? ''} />
                </label>
              </div>
              <div className="row">
                <label className="field">
                  <span>HBL / AWB</span>
                  <input name="hbl_awb" className="mono" defaultValue={s.hbl_awb ?? ''} />
                </label>
                <label className="field">
                  <span>Container</span>
                  <input name="container" className="mono" defaultValue={s.container ?? ''} />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  <span>Tracking-Link</span>
                  <input name="tracking_url" type="url" defaultValue={s.tracking_url ?? ''} placeholder="https://…" />
                </label>
              </div>
              <div className="row">
                <label className="field shrink">
                  <span>ETD</span>
                  <input type="date" name="etd" defaultValue={s.etd ?? ''} />
                </label>
                <label className="field shrink">
                  <span>ETA</span>
                  <input type="date" name="eta" defaultValue={s.eta ?? ''} />
                </label>
                {s.verschifft_am && (
                  <label className="field shrink">
                    <span>Verschifft am</span>
                    <input type="date" name="verschifft_am" defaultValue={s.verschifft_am} />
                  </label>
                )}
                <label className="field shrink">
                  <span>kg brutto</span>
                  <input name="gewicht_kg" inputMode="decimal" defaultValue={s.gewicht_kg ?? ''} />
                </label>
                <label className="field shrink">
                  <span>cbm</span>
                  <input name="volumen_cbm" inputMode="decimal" defaultValue={s.volumen_cbm ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Packstücke</span>
                  <input name="packstuecke" inputMode="numeric" defaultValue={s.packstuecke ?? ''} />
                </label>
                <label className="field shrink">
                  <span>Zuständig</span>
                  <Auswahl name="zustaendig_id" defaultValue={s.zustaendig_id ?? ''}>
                    <option value="">—</option>
                    {nutzer.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Auswahl>
                </label>
              </div>
              <label className="field">
                <span>Notiz</span>
                <textarea name="notiz" rows={2} defaultValue={s.notiz ?? ''} />
              </label>
              <button type="submit" className="small">
                Speichern
              </button>
            </ActionForm>
          </details>
        )}
      </Card>

      <Card title={`Bestellungen & Wareneingänge (${bestellungen.length})`} tight>
        {bestellungen.length === 0 ? (
          <Empty>Noch keine Bestellung in der Sendung.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Bestellung</th>
                  <th>Lieferant</th>
                  <th>Wareneingang</th>
                  <th>Verschifft</th>
                  <th>ETA</th>
                  {darf && laufend && <th />}
                </tr>
              </thead>
              <tbody>
                {bestellungen.map((b) => {
                  const zu = eingaenge.filter((e) => e.origin_id === b.id)
                  return (
                    <tr key={b.id}>
                      <td>
                        <Link className="mono" href={`/einkauf/${b.id}`}>
                          {b.number}
                        </Link>
                        {b.incoterm ? <span className="muted small"> · {b.incoterm}</span> : null}
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/lieferanten/${b.partner_id}`}>{b.lieferant}</Link>
                      </td>
                      <td className="small">
                        {zu.length === 0
                          ? '—'
                          : zu.map((e, i) => (
                              <span key={e.id}>
                                {i > 0 && ', '}
                                <Link className="mono" href={`/lager/${e.id}`}>
                                  {e.number}
                                </Link>{' '}
                                <Badge state={e.state} kind="picking" />
                              </span>
                            ))}
                      </td>
                      <td className="small nowrap">{date(b.verschifft_am)}</td>
                      <td className="small nowrap">{date(b.eta)}</td>
                      {darf && laufend && (
                        <td className="num">
                          <ActionButton
                            className="small"
                            action={sendungBestellungLoesen.bind(null, id, b.id)}
                            confirm={`${b.number} aus ${s.nummer} nehmen?`}
                          >
                            Herausnehmen
                          </ActionButton>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        {ohneEingang.length > 0 && (
          <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
            Ohne Wareneingang dieser Sendung: {ohneEingang.map((b) => b.number).join(', ')} — der offene Eingang hängt an einer
            anderen Sendung (Teillieferung); der Rest kommt als Backorder mit einer späteren Sendung.
          </p>
        )}
        {darf && laufend && (
          <ActionForm action={sendungBestellungZuordnen.bind(null, id)} style={{ padding: '10px 12px' }}>
            <div className="row">
              <label className="field" style={{ flex: 2 }}>
                <span>Bestellung aufnehmen</span>
                <Auswahl name="bestellung" defaultValue="">
                  <option value="">—</option>
                  {kandidaten.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>oder Nummern</span>
                <input name="bestellnummern" className="mono" placeholder="P00042, P00043" />
              </label>
              <div className="field shrink">
                <button type="submit" className="small">
                  Aufnehmen
                </button>
              </div>
            </div>
          </ActionForm>
        )}
      </Card>

      <Card
        title={`Kosten (${aktiv.length})`}
        tight
        actions={
          darf && s.status !== 'storniert' ? (
            <>
              {s.status !== 'abgerechnet' && (
                <ActionButton className="small" action={sendungSchaetzen.bind(null, id)}>
                  Fracht und Zoll schätzen
                </ActionButton>
              )}
              <ActionButton
                className="small"
                action={sendungVerteilen.bind(null, id)}
                disabled={offenVerteilen.length === 0 || eingaengeGebucht.length === 0 || eingaengeOffen.length > 0}
              >
                Kosten verteilen
              </ActionButton>
            </>
          ) : undefined
        }
      >
        {kosten.length === 0 ? (
          <Empty>Noch keine Kosten. „Fracht und Zoll schätzen" rechnet aus Gewicht, Frachtsätzen und Zolltarifen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th className="num">Betrag</th>
                  <th>Grundlage</th>
                  <th>Rechnungssteller</th>
                  <th>Stand</th>
                  {darf && <th />}
                </tr>
              </thead>
              <tbody>
                {kosten.map((k) => (
                  <tr key={k.id} className={k.storniert_am || k.ersetzt_durch_id ? 'muted' : undefined}>
                    <td>{KOSTEN_ARTEN[k.art]}</td>
                    <td className="num mono">{money(k.betrag, k.waehrung)}</td>
                    <td className="small">
                      {k.schaetzung ? 'Schätzung' : k.aus_zollbescheid ? 'Zollbescheid' : 'Rechnung'}
                      {k.vendor_bill_id && (
                        <>
                          {' · '}
                          <Link className="mono" href={`/einkauf/rechnungen/${k.vendor_bill_id}`}>
                            {k.rechnung}
                          </Link>
                        </>
                      )}
                      {k.notiz && <div className="muted">{k.notiz}</div>}
                    </td>
                    <td className="small">
                      {k.partner_id ? <Link href={`/einkauf/lieferanten/${k.partner_id}`}>{k.partner}</Link> : '—'}
                    </td>
                    <td className="small nowrap">
                      {k.storniert_am
                        ? 'storniert'
                        : k.ersetzt_durch_id
                          ? 'durch Rechnung ersetzt'
                          : k.art === 'eust'
                            ? 'nicht verteilt (Vorsteuer)'
                            : k.verteilt_am
                              ? `verteilt ${date(k.verteilt_am)}`
                              : 'offen'}
                    </td>
                    {darf && (
                      <td className="num">
                        {!k.storniert_am && !k.ersetzt_durch_id && s.status !== 'storniert' && (
                          <ActionButton
                            className="small"
                            action={sendungKostenEntfernen.bind(null, id, k.id)}
                            confirm={`${KOSTEN_ARTEN[k.art]} ${money(k.betrag, k.waehrung)} stornieren? Gebuchte Landed Costs werden zurückgenommen.`}
                          >
                            Stornieren
                          </ActionButton>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {eust > 0 && (
          <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
            Einfuhrumsatzsteuer {money(eust)} — Vorsteuer, kein Einstand: sie wird nie auf die Ware verteilt.
          </p>
        )}
        {darf && s.status !== 'storniert' && (
          <ActionForm action={sendungKostenErfassen.bind(null, id)} style={{ padding: '10px 12px' }}>
            <div className="row">
              <label className="field shrink">
                <span>Art</span>
                <Auswahl name="art" defaultValue="fracht">
                  {Object.entries(KOSTEN_ARTEN).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Betrag</span>
                <input name="betrag" inputMode="decimal" required placeholder="1.250,00" />
              </label>
              <label className="field shrink">
                <span>Währung</span>
                <input name="waehrung" className="mono" maxLength={3} defaultValue="EUR" />
              </label>
              <label className="field shrink">
                <span>Belegdatum</span>
                <input type="date" name="belegdatum" />
              </label>
              <label className="field">
                <span>Rechnungssteller</span>
                <Auswahl kurzanlage={kurzLieferant(user)} name="partner_id" defaultValue={s.spediteur_id ?? ''}>
                  <option value="">—</option>
                  {partner.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Lieferantenrechnung (optional)</span>
                <Auswahl name="vendor_bill_id" defaultValue="">
                  <option value="">—</option>
                  {rechnungen.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Dokument (optional)</span>
                <Auswahl name="dokument_id" defaultValue="">
                  <option value="">—</option>
                  {dokumente.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" name="schaetzung" />
                <span>Schätzung</span>
              </label>
              <div className="field shrink">
                <button type="submit" className="small primary">
                  Kosten erfassen
                </button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              Eine Rechnung ersetzt die offenen Schätzungen derselben Art — beim Verteilen wird die Differenz korrigiert
              (Storno der Schätzung, Neubuchung). Fracht wird nach Gewicht verteilt, wenn jede Position eines hat, sonst
              nach Warenwert; Zoll, Versicherung und Sonstiges nach Warenwert.
            </p>
          </ActionForm>
        )}
      </Card>

      {verteilung.length > 0 && (
        <Card title={`Verteilung auf die Wareneingänge — ${money(summeVerteilt)} gebucht`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nebenkosten</th>
                  <th>Wareneingang</th>
                  <th>Art</th>
                  <th>Basis</th>
                  <th className="num">Betrag</th>
                  <th>Stand</th>
                </tr>
              </thead>
              <tbody>
                {verteilung.map((v) => (
                  <tr key={v.id} className={v.state === 'cancel' ? 'muted' : undefined}>
                    <td className="mono small">
                      <Link href={`/lager/${v.picking_id}`}>{v.number}</Link>
                    </td>
                    <td className="mono small">
                      <Link href={`/lager/${v.picking_id}`}>{v.picking}</Link>
                    </td>
                    <td className="small">
                      {KOSTEN_ARTEN[v.art]}
                      {v.is_estimate ? ' (Schätzung)' : ''}
                    </td>
                    <td className="small">{v.basis === 'weight' ? 'Gewicht' : 'Warenwert'}</td>
                    <td className="num mono">{money(v.amount, v.currency)}</td>
                    <td className="small">{v.state === 'cancel' ? 'storniert (korrigiert)' : 'gebucht'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title={`Zoll (${zoll.length} Zeile${zoll.length === 1 ? '' : 'n'})`} tight>
        {zoll.length > 0 && (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>HS-Code</th>
                  <th>Bestellung</th>
                  <th className="num">Zollwert</th>
                  <th className="num">Zoll</th>
                  <th className="num">Satz</th>
                  <th className="num">EUSt</th>
                </tr>
              </thead>
              <tbody>
                {zoll.map((z) => (
                  <tr key={z.id}>
                    <td className="mono">{z.hs_code}</td>
                    <td className="small">
                      {z.po_id ? (
                        <Link className="mono" href={`/einkauf/${z.po_id}`}>
                          {z.po}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num mono">{money(z.zollwert_eur)}</td>
                    <td className="num mono">{money(z.zoll_eur)}</td>
                    <td className="num mono">{zollsatz(z.zollwert_eur, z.zoll_eur)?.toLocaleString('de-DE') ?? '—'} %</td>
                    <td className="num mono">{money(z.eust_eur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {darf && s.status !== 'geplant' && s.status !== 'storniert' && (
          <ActionForm action={sendungZollErfassen.bind(null, id)} style={{ padding: '10px 12px' }}>
            <label className="field">
              <span>Zollbescheid — eine Zeile je HS-Code: HS-Code; Zollwert; Zoll; EUSt</span>
              <textarea
                name="zeilen"
                rows={3}
                className="mono"
                required
                placeholder={'8534 00 90; 800,00; 0,00; 152,00\n8473 30 20; 400,00; 10,00; 77,90'}
              />
            </label>
            <div className="row">
              <label className="field shrink">
                <span>Bescheid vom</span>
                <input type="date" name="belegdatum" />
              </label>
              <label className="field">
                <span>Dokument (optional)</span>
                <Auswahl name="dokument_id" defaultValue="">
                  <option value="">—</option>
                  {dokumente.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <div className="field shrink">
                <button type="submit" className="small primary">
                  Zollbescheid erfassen
                </button>
              </div>
            </div>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              Daraus entstehen Zoll (wird verteilt, ersetzt die Zoll-Schätzung) und EUSt (getrennt, nie verteilt). Ein neuer
              Bescheid ersetzt den alten. Die echten Sätze verfeinern nach der Abrechnung die Zolltarife (Einstand).
            </p>
          </ActionForm>
        )}
      </Card>

      <Card title={`Fehlende Pflichtdokumente (${fehlend.length})`} tight>
        {fehlend.length === 0 ? (
          <Empty>Nichts offen — alle fälligen Pflichtdokumente sind da.</Empty>
        ) : (
          <ul className="dok-liste">
            {fehlend.map((f) => (
              <li key={`${f.modell}:${f.record_id}:${f.bezeichnung}`} className="dok-zeile">
                <div className="dok-text">
                  <Link href={f.modell === 'purchase_order' ? `/einkauf/${f.record_id}` : pfad} className="dok-name">
                    {f.nummer}: {f.bezeichnung}
                  </Link>
                  <div className="muted small">fällig {f.faellig_am ? date(f.faellig_am) : 'jetzt'}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {darf && fehlend.length > 0 && (
          <div className="actions" style={{ padding: '10px 12px' }}>
            {fehlendSendung.length > 0 && s.spediteur_id && (
              <ActionButton className="small" action={pflichtdokumenteNachfragen.bind(null, 'eingangs_sendung', id)}>
                Beim Spediteur nachfragen
              </ActionButton>
            )}
            {fehlendBestellungen.map(([poId, nummer]) => (
              <ActionButton key={poId} className="small" action={pflichtdokumenteNachfragen.bind(null, 'purchase_order', poId)}>
                {nummer}: beim Lieferanten nachfragen
              </ActionButton>
            ))}
          </div>
        )}
      </Card>

      <DokumenteKarte modell="eingangs_sendung" recordId={id} titel="Frachtpapiere, Zoll und Rechnungen" />
      <WiedervorlagenKarte modell="eingangs_sendung" recordId={id} pfad={pfad} />
      <ProzessPanel prozessCode="eingangs_sendung" recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} nurDiagramm />
      <RecordComments model="eingangs_sendung" recordId={id} path={pfad} />
    </>
  )
}
