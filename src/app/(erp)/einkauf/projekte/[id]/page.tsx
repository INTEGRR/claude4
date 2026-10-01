import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { DokumenteKarte } from '@/components/dokumente'
import { MailThreadsKarte, WiedervorlagenKarte } from '@/components/mail-threads'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import {
  type AngebotSumme,
  type EinstandZeile,
  FRACHT_MODI,
  HINWEISE,
  PROJEKT_ARTEN,
  angebotSumme,
  bestesAngebot,
} from '@/modules/einkauf/einkaufsprojekt'
import { SPRACHEN } from '@/modules/einkauf/mail-vorlagen'
import { driveLink } from '@/modules/google/drive'
import { date, dateTime, money } from '@/modules/shared/format'
import {
  anfragenFreigeben,
  anfragenVorbereiten,
  angebotErfassen,
  angebotVerwerfen,
  bestellungZuordnen,
  positionEntfernen,
  positionSetzen,
  projektAbbrechen,
  projektAbschliessen,
  projektAendern,
  projektBestellen,
  projektEntscheiden,
} from '../actions'
import { belegLink } from '../../querverweise'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VOR_BESTELLUNG = ['bedarf', 'angefragt', 'entschieden']

/** Zahl deutsch mit bis zu vier Stellen (Stückpreise) — ohne Währung. */
const stk = (n: number | string | null | undefined, stellen = 4) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString('de-DE', { minimumFractionDigits: Math.min(2, stellen), maximumFractionDigits: stellen })

interface Position {
  id: string
  bezeichnung: string
  variant_id: string | null
  template_id: string | null
  artikel: string | null
  menge: string
  zielpreis_eur: string | null
  gewicht_g: string | null
  hs_code: string | null
  spezifikation: string | null
}

interface Angebot {
  id: string
  partner_id: string
  lieferant: string
  version: number
  waehrung: string
  incoterm_code: string | null
  incoterm_ort: string | null
  zahlungsbedingung: string | null
  anzahlung_pct: string | null
  lieferzeit_tage: number | null
  moq: string | null
  werkzeugkosten: string
  musterkosten: string
  fracht_modus: keyof typeof FRACHT_MODI | null
  fracht_je_stueck_eur: string | null
  gueltig_bis: string | null
  notiz: string | null
  verworfen: boolean
  quelle_name: string | null
  quelle_drive_id: string | null
  created_at: string
}

type EinstandVoll = EinstandZeile & {
  staffel_ab: string | null
  preis: string | null
  kurs: string | null
  ware_eur: string | null
  umlage_eur: string | null
  fracht_eur: string | null
  zoll_eur: string | null
}

/**
 * Ein Einkaufsprojekt (0097): Positionen mit Zielpreis, Anfragen je
 * Lieferant (Entwürfe, Sammelfreigabe), Angebotsvergleich in EUR je Stück
 * (Ware + Werkzeug-Umlage + Fracht + Zoll, ohne EUSt), Entscheidung,
 * Bestellungen mit Eingangsstand — daneben Mails, Dateien, Wiedervorlagen,
 * Prozess und Verlauf.
 */
export default async function ProjektPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const pfad = `/einkauf/projekte/${id}`

  const [p] = await sql<
    {
      id: string
      nummer: string
      titel: string
      art: keyof typeof PROJEKT_ARTEN
      beschreibung: string | null
      status: string
      zieltermin: string | null
      verantwortlich_id: string | null
      verantwortlich: string | null
      gewaehltes_angebot_id: string | null
      entscheidung_begruendung: string | null
      entschieden_von: string | null
      entschieden_am: string | null
      abgeschlossen_am: string | null
      abbruch_grund: string | null
      erstellt_von: string | null
      created_at: string
    }[]
  >`
    select ep.id, ep.nummer, ep.titel, ep.art, ep.beschreibung, ep.status::text as status, ep.zieltermin::text as zieltermin,
           ep.verantwortlich_id, u.name as verantwortlich, ep.gewaehltes_angebot_id, ep.entscheidung_begruendung,
           ep.entschieden_von, ep.entschieden_am::text as entschieden_am, ep.abgeschlossen_am::text as abgeschlossen_am,
           ep.abbruch_grund, ep.erstellt_von, ep.created_at::text as created_at
    from einkaufsprojekte ep left join users u on u.id = ep.verantwortlich_id
    where ep.id = ${id}`
  if (!p) notFound()
  const offen = VOR_BESTELLUNG.includes(p.status)

  const [positionen, anfragen, angebote, bestellungen, lieferanten, nutzer, dokumente, nachrichten, freiePos, waehrungen, incoterms] =
    await Promise.all([
      sql<Position[]>`
        select pos.id, pos.bezeichnung, pos.variant_id, pv.template_id, variant_display_name(pv.id) as artikel,
               pos.menge::text, pos.zielpreis_eur::text, pos.gewicht_g::text, pos.hs_code, pos.spezifikation
        from einkaufsprojekt_positionen pos left join product_variants pv on pv.id = pos.variant_id
        where pos.projekt_id = ${id} order by pos.sequence, pos.bezeichnung`,
      sql<
        {
          id: string
          partner_id: string
          lieferant: string
          sprache: string | null
          email: string | null
          status: string
          entwurf_id: string | null
          entwurf_status: string | null
          thread_id: string | null
          frist: string | null
          angefragt_am: string | null
        }[]
      >`
        select a.id, a.partner_id, pa.name as lieferant, pa.sprache, pa.email, a.status, a.entwurf_id,
               e.status::text as entwurf_status, a.thread_id, a.frist::text as frist, a.angefragt_am::text as angefragt_am
        from lieferantenanfragen a join partners pa on pa.id = a.partner_id
        left join mail_entwuerfe e on e.id = a.entwurf_id
        where a.projekt_id = ${id} order by pa.name`,
      sql<Angebot[]>`
        select a.id, a.partner_id, pa.name as lieferant, a.version, a.waehrung, a.incoterm_code, a.incoterm_ort,
               a.zahlungsbedingung, a.anzahlung_pct::text, a.lieferzeit_tage, a.moq::text, a.werkzeugkosten::text,
               a.musterkosten::text, a.fracht_modus, a.fracht_je_stueck_eur::text, a.gueltig_bis::text as gueltig_bis,
               a.notiz, a.verworfen, d.name as quelle_name, d.drive_file_id as quelle_drive_id,
               a.created_at::text as created_at
        from lieferantenangebote a join partners pa on pa.id = a.partner_id
        left join dokumente d on d.id = a.quell_dokument_id
        where a.projekt_id = ${id} order by a.verworfen, a.created_at`,
      sql<
        {
          id: string
          number: string
          state: string
          vendor_id: string
          lieferant: string
          bestellt: number
          eingegangen: number
          eta: string | null
          receipt_ids: string[]
        }[]
      >`
        select po.id, po.number, po.state::text as state, po.vendor_id, pa.name as lieferant,
               coalesce(sum(l.qty) filter (where pt.type = 'goods'), 0)::float as bestellt,
               coalesce(sum(least(l.qty_received, l.qty)) filter (where pt.type = 'goods'), 0)::float as eingegangen,
               coalesce(po.eta_confirmed::timestamptz, po.expected_arrival)::text as eta,
               array(select sp.id from stock_pickings sp
                     where sp.origin_model = 'purchase_order' and sp.origin_id = po.id and sp.state <> 'cancel'
                     order by sp.created_at) as receipt_ids
        from purchase_orders po join partners pa on pa.id = po.vendor_id
        left join purchase_order_lines l on l.order_id = po.id
        left join product_variants pv on pv.id = l.variant_id
        left join product_templates pt on pt.id = pv.template_id
        where po.einkaufsprojekt_id = ${id}
        group by po.id, pa.name order by po.created_at`,
      sql<{ id: string; name: string; sprache: string | null; email: string | null }[]>`
        select id, name, sprache, email from partners where is_vendor and active order by lower(name) limit 500`,
      sql<{ id: string; name: string }[]>`select id, name from users where active order by name`,
      sql<{ id: string; name: string }[]>`
        select d.id, d.name from dokumente d join dokument_verweise v on v.dokument_id = d.id
        where v.modell = 'einkaufsprojekt' and v.record_id = ${id} order by d.name`,
      sql<{ id: string; label: string }[]>`
        select n.id, coalesce(pa.name, n.von, '?') || ' · ' || to_char(n.datum, 'DD.MM. HH24:MI') || ' · ' || left(coalesce(n.betreff, ''), 60) as label
        from mail_nachrichten n join mail_threads t on t.id = n.thread_id left join partners pa on pa.id = t.partner_id
        where t.einkaufsprojekt_id = ${id} and n.richtung = 'eingang'
        order by n.datum desc limit 30`,
      sql<{ id: string; number: string; lieferant: string }[]>`
        select po.id, po.number, pa.name as lieferant from purchase_orders po join partners pa on pa.id = po.vendor_id
        where po.einkaufsprojekt_id is null and po.state <> 'cancel' order by po.created_at desc limit 50`,
      sql<{ code: string }[]>`select code from currencies where active order by code = 'EUR' desc, code`,
      sql<{ code: string; name: string }[]>`select code, name from incoterms order by code`,
    ])

  // Vergleich: Einstand je Angebot und Position aus der Datenbank (einstand_schaetzen).
  const einstaende = new Map<string, EinstandVoll[]>()
  for (const a of angebote) {
    einstaende.set(
      a.id,
      await sql<EinstandVoll[]>`
        select position_id, menge::float as menge, staffel_ab::text, preis::text, kurs::text, ware_eur::text, umlage_eur::text,
               fracht_eur::text, zoll_eur::text, einstand_eur::float as einstand_eur, zielpreis_eur::float as zielpreis_eur, hinweise
        from einstand_schaetzen(${a.id})`,
    )
  }
  const summen = new Map<string, AngebotSumme>(angebote.map((a) => [a.id, angebotSumme(einstaende.get(a.id) ?? [])]))
  const bestes = bestesAngebot(angebote.map((a) => ({ id: a.id, verworfen: a.verworfen, summe: summen.get(a.id)! })))
  const variantIds = positionen.map((x) => x.variant_id).filter((v): v is string => Boolean(v))
  const historie = variantIds.length
    ? await sql<{ datum: string; bestellung: string; po_id: string; vendor_id: string; lieferant: string; artikel: string; qty: number; price_unit: number; currency: string }[]>`
        select po.created_at::text as datum, po.number as bestellung, po.id as po_id, po.vendor_id, pa.name as lieferant,
               variant_display_name(l.variant_id) as artikel, l.qty::float as qty, l.price_unit::float as price_unit, po.currency
        from purchase_order_lines l join purchase_orders po on po.id = l.order_id join partners pa on pa.id = po.vendor_id
        where l.variant_id = any(${variantIds}::uuid[]) and po.state in ('purchase', 'done')
          and po.einkaufsprojekt_id is distinct from ${id}
        order by po.created_at desc limit 12`
    : []

  const entwuerfeOffen = anfragen.filter((a) => a.status === 'entwurf' && a.entwurf_status === 'entwurf').length
  const angefragtIds = new Set(anfragen.map((a) => a.partner_id))
  const gewaehlt = angebote.find((a) => a.id === p.gewaehltes_angebot_id)
  const sichtbar = angebote.filter((a) => !a.verworfen)
  const verworfen = angebote.filter((a) => a.verworfen)

  return (
    <>
      <PageHeader
        kicker={PROJEKT_ARTEN[p.art] ?? p.art}
        title={
          <>
            <span className="mono">{p.nummer}</span> {p.titel}
          </>
        }
        subtitle={
          <>
            <Badge state={p.status} kind="einkaufsprojekt" />{' '}
            {p.verantwortlich ?? 'ohne Verantwortlichen'} · Zieltermin {p.zieltermin ? date(p.zieltermin) : 'offen'}
            {gewaehlt && (
              <>
                {' · gewählt: '}
                <Link href={`/einkauf/lieferanten/${gewaehlt.partner_id}`}>{gewaehlt.lieferant}</Link>
              </>
            )}
          </>
        }
        actions={
          <Link className="btn" href="/einkauf/projekte">
            Alle Projekte
          </Link>
        }
      />

      {p.status === 'abgebrochen' && <div className="notice warn">Abgebrochen: {p.abbruch_grund}</div>}
      {p.status === 'abgeschlossen' && (
        <div className="notice info">Abgeschlossen {p.abgeschlossen_am ? dateTime(p.abgeschlossen_am) : ''} — alles geliefert.</div>
      )}
      {p.beschreibung && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{p.beschreibung}</p>}

      {/* Positionen */}
      <Card title={`Positionen (${positionen.length})`} tight>
        {positionen.length === 0 ? (
          <Empty>Noch keine Position — was soll beschafft werden?</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="num">Menge</th>
                  <th className="num">Zielpreis €/Stk</th>
                  <th className="num">Gewicht g</th>
                  <th>HS-Code</th>
                  {offen && darf && <th />}
                </tr>
              </thead>
              <tbody>
                {positionen.map((pos) => (
                  <tr key={pos.id}>
                    <td>
                      {pos.bezeichnung}
                      {pos.template_id && (
                        <div className="small">
                          <Link href={`/produkte/${pos.template_id}`}>{pos.artikel}</Link>
                        </div>
                      )}
                      {pos.spezifikation && <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{pos.spezifikation}</div>}
                      {offen && darf && (
                        <details className="small" style={{ marginTop: 6 }}>
                          <summary>Bearbeiten</summary>
                          <ActionForm action={positionSetzen.bind(null, id)} style={{ marginTop: 8 }}>
                            <input type="hidden" name="position_id" value={pos.id} />
                            <div className="row">
                              <label className="field">
                                <span>Bezeichnung</span>
                                <input name="bezeichnung" defaultValue={pos.bezeichnung} required />
                              </label>
                              <label className="field">
                                <span>Menge</span>
                                <input name="menge" inputMode="decimal" defaultValue={stk(pos.menge, 4).replace(/,00$/, '')} required />
                              </label>
                              <label className="field">
                                <span>Zielpreis €/Stk</span>
                                <input name="zielpreis_eur" inputMode="decimal" defaultValue={pos.zielpreis_eur ? stk(pos.zielpreis_eur, 6) : ''} />
                              </label>
                              <label className="field">
                                <span>Gewicht g</span>
                                <input name="gewicht_g" inputMode="decimal" defaultValue={pos.gewicht_g ? stk(pos.gewicht_g, 2) : ''} />
                              </label>
                              <label className="field">
                                <span>HS-Code</span>
                                <input name="hs_code" className="mono" defaultValue={pos.hs_code ?? ''} />
                              </label>
                            </div>
                            <label className="field">
                              <span>Spezifikation</span>
                              <textarea name="spezifikation" rows={2} defaultValue={pos.spezifikation ?? ''} />
                            </label>
                            <button type="submit" className="small">Speichern</button>
                          </ActionForm>
                        </details>
                      )}
                    </td>
                    <td className="num mono">{stk(pos.menge, 4).replace(/,00$/, '')}</td>
                    <td className="num mono">{pos.zielpreis_eur ? stk(pos.zielpreis_eur) : '—'}</td>
                    <td className="num mono">{pos.gewicht_g ? stk(pos.gewicht_g, 2) : '—'}</td>
                    <td className="mono small">{pos.hs_code ?? '—'}</td>
                    {offen && darf && (
                      <td>
                        <ActionButton action={positionEntfernen.bind(null, id, pos.id)} className="small" confirm={`„${pos.bezeichnung}" samt Angebotspreisen entfernen?`}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {offen && darf && (
          <details style={{ padding: '10px 12px' }} open={positionen.length === 0}>
            <summary className="small">Position hinzufügen</summary>
            <ActionForm action={positionSetzen.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Bezeichnung</span>
                  <input name="bezeichnung" placeholder="z. B. Keycap-Set PBT Dye-Sub" />
                </label>
                <label className="field">
                  <span>oder Artikel (SKU)</span>
                  <input name="produkt" className="mono" placeholder="SKU oder Barcode" />
                </label>
                <label className="field">
                  <span>Menge</span>
                  <input name="menge" inputMode="decimal" required placeholder="500" />
                </label>
                <label className="field">
                  <span>Zielpreis €/Stk</span>
                  <input name="zielpreis_eur" inputMode="decimal" placeholder="0,85" />
                </label>
                <label className="field">
                  <span>Gewicht g</span>
                  <input name="gewicht_g" inputMode="decimal" placeholder="180" />
                </label>
                <label className="field">
                  <span>HS-Code</span>
                  <input name="hs_code" className="mono" placeholder="8473 30" />
                </label>
              </div>
              <label className="field">
                <span>Spezifikation (geht mit in die Anfrage)</span>
                <textarea name="spezifikation" rows={2} placeholder="Material, Farbe, Profil …" />
              </label>
              <button type="submit" className="small primary">Hinzufügen</button>
            </ActionForm>
          </details>
        )}
      </Card>

      {/* Anfragen */}
      <div id="anfragen">
      <Card
        title={`Anfragen (${anfragen.length})`}
        tight
        actions={
          darf && entwuerfeOffen > 0 && ['bedarf', 'angefragt'].includes(p.status) ? (
            <ActionButton
              action={anfragenFreigeben.bind(null, id)}
              className="small primary"
              confirm={`${entwuerfeOffen} Anfrage(n) freigeben und über das Einkaufspostfach senden?`}
            >
              Anfragen freigeben ({entwuerfeOffen})
            </ActionButton>
          ) : undefined
        }
      >
        {anfragen.length === 0 ? (
          <Empty>Noch keine Anfrage. Lieferanten wählen — je Lieferant entsteht ein Entwurf in seiner Sprache.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Lieferant</th>
                  <th>Sprache</th>
                  <th>Frist</th>
                  <th>Mail</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {anfragen.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/einkauf/lieferanten/${a.partner_id}`}>{a.lieferant}</Link>
                      {!a.email && <div className="small wv-ueberfaellig">keine Mailadresse</div>}
                    </td>
                    <td className="small">{a.sprache ? SPRACHEN[a.sprache as keyof typeof SPRACHEN] : '—'}</td>
                    <td className="small nowrap">{a.frist ? date(a.frist) : '—'}</td>
                    <td className="small">
                      {a.thread_id ? (
                        <Link href={`/einkauf/posteingang/${a.thread_id}`}>Gespräch</Link>
                      ) : a.entwurf_id ? (
                        <Link href={`/einkauf/entwuerfe/${a.entwurf_id}`}>
                          Entwurf{a.entwurf_status && a.entwurf_status !== 'entwurf' ? ` (${a.entwurf_status})` : ''}
                        </Link>
                      ) : (
                        '—'
                      )}
                      {a.angefragt_am && <div className="muted">{dateTime(a.angefragt_am)}</div>}
                    </td>
                    <td>
                      {/* Status → das Gespräch (oder der Entwurf) dahinter. */}
                      <Badge
                        state={a.status}
                        kind="lieferantenanfrage"
                        href={
                          a.thread_id
                            ? `/einkauf/posteingang/${a.thread_id}`
                            : a.entwurf_id
                              ? `/einkauf/entwuerfe/${a.entwurf_id}`
                              : undefined
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {darf && ['bedarf', 'angefragt'].includes(p.status) && positionen.length > 0 && (
          <details style={{ padding: '10px 12px' }} open={anfragen.length === 0}>
            <summary className="small">Lieferanten anfragen</summary>
            <ActionForm action={anfragenVorbereiten.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Lieferanten (Strg/⌘ für mehrere)</span>
                  <select name="partner_id" multiple size={Math.min(8, Math.max(3, lieferanten.length))} required>
                    {lieferanten
                      .filter((l) => !angefragtIds.has(l.id))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                          {l.sprache ? ` (${l.sprache})` : ''}
                          {l.email ? '' : ' — ohne Mail'}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  <span>Antwort bis</span>
                  <input type="date" name="frist" />
                </label>
              </div>
              {dokumente.length > 0 && (
                <div className="field">
                  <span className="feld-titel">Dateien anhängen</span>
                  <div>
                    {dokumente.map((d) => (
                      <label key={d.id} className="small" style={{ display: 'block' }}>
                        <input type="checkbox" name="dokument_id" value={d.id} /> {d.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <button type="submit" className="small">Anfragen vorbereiten</button>
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Je Lieferant ein Entwurf in seiner Sprache (Deutsch zum Mitlesen) mit {p.nummer} im Betreff und den Positionen —
                ohne Zielpreis. Gegenlesen, dann oben „Anfragen freigeben".
              </p>
            </ActionForm>
          </details>
        )}
      </Card>
      </div>

      {/* Angebotsvergleich */}
      <Card title={`Angebotsvergleich (${sichtbar.length})`} tight>
        {sichtbar.length === 0 ? (
          <Empty>Noch kein Angebot. Angebote kommen als PDF, Excel oder im Mailtext — unten erfassen.</Empty>
        ) : (
          <TableWrap>
            <table className="vergleich">
              <thead>
                <tr>
                  <th>EUR je Stück (Einstand)</th>
                  {sichtbar.map((a) => (
                    <th key={a.id} className="num">
                      <Link href={`/einkauf/lieferanten/${a.partner_id}`}>{a.lieferant}</Link>
                      {a.version > 1 ? ` v${a.version}` : ''}
                      {a.id === bestes && (
                        <div>
                          <span className="badge success">günstigster Einstand</span>
                        </div>
                      )}
                      {a.id === p.gewaehltes_angebot_id && (
                        <div>
                          <span className="badge info">gewählt</span>
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positionen.map((pos) => (
                  <tr key={pos.id}>
                    <td>
                      {pos.bezeichnung}
                      <div className="muted small">
                        {stk(pos.menge, 4).replace(/,00$/, '')} Stk · Ziel {pos.zielpreis_eur ? `${stk(pos.zielpreis_eur)} €` : '—'}
                      </div>
                    </td>
                    {sichtbar.map((a) => {
                      const z = einstaende.get(a.id)?.find((x) => x.position_id === pos.id)
                      const ueberZiel = z?.einstand_eur !== null && z?.zielpreis_eur !== null && z && Number(z.einstand_eur) > Number(z.zielpreis_eur)
                      return (
                        <td key={a.id} className="num">
                          {z && z.einstand_eur !== null ? (
                            <>
                              <span
                                className={`mono ${ueberZiel ? 'wv-ueberfaellig' : ''}`}
                                title={`Ware ${stk(z.ware_eur)} + Werkzeug/Muster ${stk(z.umlage_eur)} + Fracht ${stk(z.fracht_eur)} + Zoll ${stk(z.zoll_eur)} €`}
                              >
                                {stk(z.einstand_eur)} €
                              </span>
                              <div className="muted small">
                                {stk(z.preis)} {a.waehrung} ab {stk(z.staffel_ab, 0)}
                              </div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {z?.hinweise.map((h) => (
                            <div key={h} className="small wv-ueberfaellig">
                              {HINWEISE[h as keyof typeof HINWEISE] ?? h}
                            </div>
                          ))}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Summe Einstand</strong>
                  </td>
                  {sichtbar.map((a) => {
                    const s = summen.get(a.id)!
                    return (
                      <td key={a.id} className="num">
                        <strong className="mono">{s.gesamt !== null ? money(s.gesamt) : '—'}</strong>
                        {s.abweichungPct !== null && (
                          <div className={`small ${s.abweichungPct > 0 ? 'wv-ueberfaellig' : 'muted'}`}>
                            {s.abweichungPct > 0 ? '+' : ''}
                            {String(s.abweichungPct).replace('.', ',')} % zum Ziel
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
                <tr className="small">
                  <td>Konditionen</td>
                  {sichtbar.map((a) => (
                    <td key={a.id} className="num">
                      {a.incoterm_code ?? '—'}
                      {a.incoterm_ort ? ` ${a.incoterm_ort}` : ''} · {a.lieferzeit_tage !== null ? `${a.lieferzeit_tage} Tage` : 'Lieferzeit ?'}
                      <div className="muted">
                        {a.anzahlung_pct !== null ? `${stk(a.anzahlung_pct, 0)} % Anzahlung` : a.zahlungsbedingung ?? 'Zahlung ?'}
                        {a.moq ? ` · MOQ ${stk(a.moq, 0)}` : ''}
                      </div>
                      {(Number(a.werkzeugkosten) > 0 || Number(a.musterkosten) > 0) && (
                        <div className="muted">
                          {Number(a.werkzeugkosten) > 0 ? `Werkzeug ${stk(a.werkzeugkosten, 2)} ${a.waehrung}` : ''}
                          {Number(a.musterkosten) > 0 ? ` Muster ${stk(a.musterkosten, 2)} ${a.waehrung}` : ''}
                        </div>
                      )}
                      <div className="muted">
                        {a.incoterm_code && ['DAP', 'DPU', 'DDP'].includes(a.incoterm_code)
                          ? 'Fracht beim Lieferanten'
                          : a.fracht_je_stueck_eur
                            ? `Fracht ${stk(a.fracht_je_stueck_eur)} €/Stk`
                            : `Fracht ${FRACHT_MODI[a.fracht_modus ?? 'see']}`}
                        {a.gueltig_bis ? ` · gültig bis ${date(a.gueltig_bis)}` : ''}
                      </div>
                      {a.quelle_name && (
                        <div className="muted">
                          Quelle:{' '}
                          {a.quelle_drive_id ? (
                            <a href={driveLink(a.quelle_drive_id)} target="_blank" rel="noopener">
                              {a.quelle_name}
                            </a>
                          ) : (
                            a.quelle_name
                          )}
                        </div>
                      )}
                      {a.notiz && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{a.notiz}</div>}
                    </td>
                  ))}
                </tr>
                {darf && offen && (
                  <tr>
                    <td />
                    {sichtbar.map((a) => (
                      <td key={a.id} className="num">
                        {a.id !== p.gewaehltes_angebot_id && (
                          <ActionForm action={projektEntscheiden.bind(null, id)}>
                            <input type="hidden" name="angebot_id" value={a.id} />
                            <input name="begruendung" placeholder="Begründung (optional)" className="small" />
                            <button type="submit" className="small primary" style={{ marginTop: 4 }}>
                              Wählen
                            </button>
                          </ActionForm>
                        )}
                        {a.id !== p.gewaehltes_angebot_id && (
                          <ActionButton action={angebotVerwerfen.bind(null, id, a.id, true)} className="small">
                            Verwerfen
                          </ActionButton>
                        )}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
        {verworfen.length > 0 && (
          <div className="small muted" style={{ padding: '8px 12px' }}>
            Verworfen:{' '}
            {verworfen.map((a, i) => (
              <span key={a.id}>
                {i > 0 ? ', ' : ''}
                <Link href={`/einkauf/lieferanten/${a.partner_id}`}>{a.lieferant}</Link>
                {a.version > 1 ? ` v${a.version}` : ''}
                {darf && offen && (
                  <>
                    {' '}
                    <ActionButton action={angebotVerwerfen.bind(null, id, a.id, false)} className="small">
                      zurückholen
                    </ActionButton>
                  </>
                )}
              </span>
            ))}
          </div>
        )}
        <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
          Einstand = Staffelpreis bei Projektmenge × EZB-Kurs + Werkzeug/Muster (nach Warenwert umgelegt) + Fracht (Satz je kg,
          D-Klauseln ohne) + Zoll nach HS-Code (DDP ohne); EUSt ist nicht enthalten. Sätze unter{' '}
          <Link href="/einkauf/einstand">Einstand</Link>, Kurse unter <Link href="/einkauf/kurse">Wechselkurse</Link>.
        </p>
        {darf && offen && positionen.length > 0 && (
          <details style={{ padding: '10px 12px' }} open={angebote.length === 0 && anfragen.length > 0}>
            <summary className="small">Angebot erfassen</summary>
            <ActionForm action={angebotErfassen.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Lieferant</span>
                  <select name="partner_id" required defaultValue={anfragen.find((a) => a.status === 'angefragt')?.partner_id ?? ''}>
                    <option value="" disabled>
                      — wählen —
                    </option>
                    {anfragen.length > 0 && (
                      <optgroup label="Angefragt">
                        {anfragen.map((a) => (
                          <option key={a.partner_id} value={a.partner_id}>
                            {a.lieferant}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Alle Lieferanten">
                      {lieferanten
                        .filter((l) => !angefragtIds.has(l.id))
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                    </optgroup>
                  </select>
                </label>
                <label className="field">
                  <span>Währung</span>
                  <select name="waehrung" defaultValue="USD" className="mono">
                    {waehrungen.map((w) => (
                      <option key={w.code} value={w.code}>
                        {w.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Incoterm</span>
                  <select name="incoterm_code" defaultValue="" className="mono">
                    <option value="">—</option>
                    {incoterms.map((i) => (
                      <option key={i.code} value={i.code}>
                        {i.code} – {i.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Ort</span>
                  <input name="incoterm_ort" placeholder="Shenzhen" />
                </label>
              </div>
              <div className="row">
                <label className="field">
                  <span>Anzahlung %</span>
                  <input name="anzahlung_pct" inputMode="decimal" placeholder="30" />
                </label>
                <label className="field">
                  <span>Zahlung (Text)</span>
                  <input name="zahlungsbedingung" placeholder="T/T 30/70" />
                </label>
                <label className="field">
                  <span>Lieferzeit Tage</span>
                  <input name="lieferzeit_tage" inputMode="numeric" placeholder="35" />
                </label>
                <label className="field">
                  <span>MOQ</span>
                  <input name="moq" inputMode="decimal" />
                </label>
                <label className="field">
                  <span>Gültig bis</span>
                  <input type="date" name="gueltig_bis" />
                </label>
              </div>
              <div className="row">
                <label className="field">
                  <span>Werkzeugkosten (Angebotswährung)</span>
                  <input name="werkzeugkosten" inputMode="decimal" placeholder="0" />
                </label>
                <label className="field">
                  <span>Musterkosten</span>
                  <input name="musterkosten" inputMode="decimal" placeholder="0" />
                </label>
                <label className="field">
                  <span>Fracht</span>
                  <select name="fracht_modus" defaultValue="see">
                    {Object.entries(FRACHT_MODI).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label} (Satz je kg)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>oder Fracht €/Stk fest</span>
                  <input name="fracht_je_stueck_eur" inputMode="decimal" />
                </label>
              </div>
              <div className="field">
                <span className="feld-titel">Preise je Position — eine Staffel je Zeile „Menge: Preis"</span>
                {positionen.map((pos) => (
                  <label key={pos.id} className="field">
                    <span>
                      {pos.bezeichnung} ({stk(pos.menge, 4).replace(/,00$/, '')} Stk)
                    </span>
                    <textarea name={`staffeln_${pos.id}`} rows={2} className="mono" placeholder={'500: 0,85\n1000: 0,72'} />
                  </label>
                ))}
              </div>
              <div className="row">
                <label className="field">
                  <span>Quelle: Datei</span>
                  <select name="quell_dokument_id" defaultValue="">
                    <option value="">—</option>
                    {dokumente.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>oder Nachricht</span>
                  <select name="quell_nachricht_id" defaultValue="">
                    <option value="">—</option>
                    {nachrichten.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Notiz</span>
                <textarea name="notiz" rows={2} />
              </label>
              <button type="submit" className="small primary">Angebot speichern</button>
            </ActionForm>
          </details>
        )}
      </Card>

      {/* Entscheidung und Bestellungen */}
      {gewaehlt && (
        <Card
          title="Entscheidung"
          actions={
            darf && p.status === 'entschieden' ? (
              <ActionButton
                action={projektBestellen.bind(null, id)}
                className="small primary"
                confirm={`Bestellung bei ${gewaehlt.lieferant} anlegen (Entwurf)? Neue Teile bekommen einen Artikel.`}
              >
                Bestellung anlegen
              </ActionButton>
            ) : undefined
          }
        >
          <p className="small" style={{ margin: 0 }}>
            <strong>
              <Link href={`/einkauf/lieferanten/${gewaehlt.partner_id}`}>{gewaehlt.lieferant}</Link>
            </strong>
            {summen.get(gewaehlt.id)?.gesamt != null ? ` · Einstand ${money(summen.get(gewaehlt.id)!.gesamt!)}` : ''}
            {p.entschieden_von ? ` · ${p.entschieden_von}, ${p.entschieden_am ? dateTime(p.entschieden_am) : ''}` : ''}
          </p>
          {p.entscheidung_begruendung && <p className="small muted" style={{ margin: '4px 0 0' }}>{p.entscheidung_begruendung}</p>}
        </Card>
      )}

      {(bestellungen.length > 0 || ['bestellt', 'entschieden'].includes(p.status)) && (
        <Card
          title={`Bestellungen (${bestellungen.length})`}
          tight
          actions={
            darf && p.status === 'bestellt' ? (
              <ActionButton action={projektAbschliessen.bind(null, id)} className="small" confirm="Projekt von Hand abschließen?">
                Abschließen
              </ActionButton>
            ) : undefined
          }
        >
          {bestellungen.length === 0 ? (
            <Empty>Noch keine Bestellung.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Bestellung</th>
                    <th>Lieferant</th>
                    <th>ETA</th>
                    <th className="num">Eingegangen</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bestellungen.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <Link href={`/einkauf/${b.id}`} className="mono">
                          {b.number}
                        </Link>
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/lieferanten/${b.vendor_id}`}>{b.lieferant}</Link>
                      </td>
                      <td className="small nowrap">{b.eta ? date(b.eta) : '—'}</td>
                      <td className="num mono small">
                        {b.bestellt > 0 ? (
                          // Eingangsstand → der Wareneingang dahinter.
                          <Link
                            href={
                              belegLink(b.receipt_ids, (x) => `/lager/${x}`, `/einkauf/${b.id}#wareneingaenge`) ??
                              `/einkauf/${b.id}`
                            }
                          >
                            {stk(b.eingegangen, 0)} / {stk(b.bestellt, 0)}
                          </Link>
                        ) : (
                          'Dienstleistung'
                        )}
                      </td>
                      <td>
                        <Badge state={b.state} kind="purchase" href={`/einkauf/${b.id}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {darf && p.status !== 'abgebrochen' && freiePos.length > 0 && (
            <details style={{ padding: '10px 12px' }}>
              <summary className="small">Bestehende Bestellung zuordnen</summary>
              <ActionForm action={bestellungZuordnen.bind(null, id)} style={{ marginTop: 8 }}>
                <div className="row">
                  <label className="field">
                    <span>Bestellung</span>
                    <select name="purchase_order_id" required>
                      {freiePos.map((po) => (
                        <option key={po.id} value={po.id}>
                          {po.number} · {po.lieferant}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="shrink field">
                    <button type="submit" className="small">Zuordnen</button>
                  </div>
                </div>
              </ActionForm>
            </details>
          )}
        </Card>
      )}

      {historie.length > 0 && (
        <Card title="Preishistorie (frühere Bestellungen dieser Artikel)" tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Bestellung</th>
                  <th>Lieferant</th>
                  <th>Artikel</th>
                  <th className="num">Menge</th>
                  <th className="num">Preis</th>
                </tr>
              </thead>
              <tbody>
                {historie.map((hz, i) => (
                  <tr key={i}>
                    <td className="small nowrap">{date(hz.datum)}</td>
                    <td>
                      <Link href={`/einkauf/${hz.po_id}`} className="mono small">
                        {hz.bestellung}
                      </Link>
                    </td>
                    <td className="small">
                      <Link href={`/einkauf/lieferanten/${hz.vendor_id}`}>{hz.lieferant}</Link>
                    </td>
                    <td className="small">{hz.artikel}</td>
                    <td className="num mono small">{stk(hz.qty, 0)}</td>
                    <td className="num mono small">
                      {stk(hz.price_unit)} {hz.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <MailThreadsKarte
        einkaufsprojektId={id}
        lieferanten={anfragen.map((a) => ({ id: a.partner_id, name: a.lieferant }))}
      />
      <DokumenteKarte modell="einkaufsprojekt" recordId={id} titel="Dateien des Projekts (Zeichnungen, BOM, Angebote)" />
      <WiedervorlagenKarte modell="einkaufsprojekt" recordId={id} pfad={pfad} />

      {darf && p.status !== 'abgeschlossen' && p.status !== 'abgebrochen' && (
        <Card title="Projekt">
          <details>
            <summary className="small">Bearbeiten</summary>
            <ActionForm action={projektAendern.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Titel</span>
                  <input name="titel" defaultValue={p.titel} required />
                </label>
                <label className="field">
                  <span>Art</span>
                  <select name="art" defaultValue={p.art}>
                    {Object.entries(PROJEKT_ARTEN).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Zieltermin</span>
                  <input type="date" name="zieltermin" defaultValue={p.zieltermin ?? ''} />
                </label>
                <label className="field">
                  <span>Verantwortlich</span>
                  <select name="verantwortlich_id" defaultValue={p.verantwortlich_id ?? ''}>
                    <option value="">—</option>
                    {nutzer.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Beschreibung</span>
                <textarea name="beschreibung" rows={3} defaultValue={p.beschreibung ?? ''} />
              </label>
              <button type="submit" className="small">Speichern</button>
            </ActionForm>
          </details>
          <details style={{ marginTop: 8 }}>
            <summary className="small">Abbrechen</summary>
            <ActionForm action={projektAbbrechen.bind(null, id)} style={{ marginTop: 8 }}>
              <div className="row">
                <label className="field">
                  <span>Grund</span>
                  <input name="grund" required placeholder="z. B. Bedarf entfällt" />
                </label>
                <div className="shrink field">
                  <button type="submit" className="small danger">Projekt abbrechen</button>
                </div>
              </div>
              <p className="small muted" style={{ margin: '6px 0 0' }}>Offene Anfrage-Entwürfe werden verworfen; Bestellungen vorher stornieren.</p>
            </ActionForm>
          </details>
        </Card>
      )}

      <ProzessPanel prozessCode="einkaufsprojekt" recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} nurDiagramm />
      <RecordComments model="einkaufsprojekt" recordId={id} path={pfad} />
    </>
  )
}
