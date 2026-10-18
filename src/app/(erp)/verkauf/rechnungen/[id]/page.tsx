import { requireArea } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { Statusleiste } from '@/components/statusleiste'
import { RecordComments } from '@/components/record-comments'
import { date, isoDatum, money, qty } from '@/modules/shared/format'
import { zahlungStornieren } from '../../../finanzen/actions'
import { gutschriftErstellen, rechnungAlsBezahlt, rechnungDetails, rechnungMahnen, rechnungStornieren, rechnungZahlen } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Kundenrechnung / Gutschrift (0115): Beleg, Positionen, Zahlungen,
 * Gutschriften — und das PDF. Die Beträge sind Schnappschüsse der Lieferung.
 */
export default async function KundenrechnungPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('verkauf')
  const { id } = await params
  const darfFinanzen = canAccess(user.rollen, 'finanzen', user.befugnisse)

  const [k] = await sql<
    {
      id: string
      nummer: string
      art: 'rechnung' | 'gutschrift'
      status: string
      rechnungsdatum: string
      leistungsdatum: string | null
      faellig_am: string | null
      zahlungsart: string | null
      bezahlt_am: string | null
      mahnstufe: number
      gemahnt_am: string | null
      waehrung: string
      netto: number
      steuer: number
      brutto: number
      anschrift: Record<string, string | null>
      kundennummer: string | null
      kundenreferenz: string | null
      ansprechpartner: string | null
      notiz: string | null
      grund: string | null
      partner_id: string
      kunde: string
      sales_order_id: string | null
      auftrag: string | null
      picking_id: string | null
      lieferung: string | null
      storno_von_id: string | null
      storno_nummer: string | null
      offen: number
      datev_uebergeben_am: string | null
      ueberfaellig: boolean
      probe: boolean
    }[]
  >`
    select k.id, k.nummer, k.art::text as art, k.status::text as status, k.rechnungsdatum::text as rechnungsdatum,
           k.leistungsdatum::text as leistungsdatum, k.faellig_am::text as faellig_am, k.zahlungsart,
           k.bezahlt_am::text as bezahlt_am, k.mahnstufe, k.gemahnt_am::text as gemahnt_am, k.waehrung,
           k.netto, k.steuer, k.brutto, k.anschrift, k.kundennummer, k.kundenreferenz, k.ansprechpartner,
           k.notiz, k.grund, k.partner_id, p.name as kunde, k.sales_order_id, so.number as auftrag,
           k.picking_id, sp.number as lieferung, k.storno_von_id, st.nummer as storno_nummer,
           kundenrechnung_offen(k.id) as offen, k.datev_uebergeben_am::text as datev_uebergeben_am,
           (k.status = 'offen' and k.art = 'rechnung' and k.faellig_am < current_date) as ueberfaellig, k.probe
    from kundenrechnungen k
    left join partners p on p.id = k.partner_id
    left join sales_orders so on so.id = k.sales_order_id
    left join stock_pickings sp on sp.id = k.picking_id
    left join kundenrechnungen st on st.id = k.storno_von_id
    where k.id = ${id}`
  if (!k) notFound()

  const positionen = await sql<
    { id: string; art: string; bezeichnung: string; menge: number; einheit: string; einzelpreis: number; listenpreis: number | null; rabatt_pct: number; steuersatz: number; netto: number; brutto: number; gutgeschrieben: number }[]
  >`
    select kp.id, kp.art, kp.bezeichnung, kp.menge, kp.einheit, kp.einzelpreis, kp.listenpreis, kp.rabatt_pct,
           kp.steuersatz, kp.netto, kp.brutto,
           coalesce((select sum(g.menge) from kundenrechnung_positionen g
                     join kundenrechnungen gk on gk.id = g.rechnung_id and gk.storno_von_id = kp.rechnung_id
                     where g.art = kp.art and coalesce(g.variant_id::text, '') = coalesce(kp.variant_id::text, '')
                       and g.bezeichnung = kp.bezeichnung), 0) as gutgeschrieben
    from kundenrechnung_positionen kp where kp.rechnung_id = ${id} order by kp.sequence`

  const gutschriften = await sql<{ id: string; nummer: string; status: string; brutto: number; rechnungsdatum: string; grund: string | null }[]>`
    select id, nummer, status::text as status, brutto, rechnungsdatum::text as rechnungsdatum, grund
    from kundenrechnungen where storno_von_id = ${id} order by created_at`

  const zahlungen = darfFinanzen
    ? await sql<{ id: string; nummer: string; richtung: string; betrag_eur: number; gezahlt_am: string; konto: string | null; storniert: boolean }[]>`
        select z.id, z.nummer, z.richtung, z.betrag_eur, z.gezahlt_am::text as gezahlt_am, b.name as konto,
               z.storniert_am is not null as storniert
        from zahlungen z left join bankkonten b on b.id = z.bankkonto_id
        where z.kundenrechnung_id = ${id} order by z.gezahlt_am`
    : []
  const konten = darfFinanzen
    ? await sql<{ id: string; name: string }[]>`select id, name from bankkonten where aktiv order by sequence, name`
    : []

  const a = k.anschrift ?? {}
  const anschrift = [
    a.company && a.company !== a.name ? a.company : null, a.name,
    [a.street, a.house].filter(Boolean).join(' ') || null, a.street2,
    [a.zip, a.city].filter(Boolean).join(' ') || null, a.country,
  ].filter(Boolean) as string[]
  const istRechnung = k.art === 'rechnung'
  const offen = Number(k.offen)
  const mahntext = ['—', 'Zahlungserinnerung', '1. Mahnung', '2. Mahnung'][Number(k.mahnstufe)] ?? '—'

  return (
    <>
      <PageHeader
        title={
          <span className="actions" style={{ gap: 8 }}>
            <span className="mono">{k.nummer}</span>
            {k.probe && <span className="badge warn" title="Testbeleg des Rechnungs-Probelaufs">Testbeleg · Probelauf</span>}
            {!istRechnung && <span className="badge info">Gutschrift</span>}
            {k.ueberfaellig && <span className="badge danger">überfällig</span>}
          </span>
        }
        subtitle={
          <>
            <Link href={`/kontakte/${k.partner_id}`}>{k.kunde}</Link>
            {k.sales_order_id && (
              <> · Auftrag <Link className="mono" href={`/verkauf/${k.sales_order_id}`}>{k.kundenreferenz ?? k.auftrag}</Link></>
            )}
            {k.picking_id && <> · Lieferung <Link className="mono" href={`/lager/${k.picking_id}`}>{k.lieferung}</Link></>}
            {k.storno_von_id && (
              <> · zu Rechnung <Link className="mono" href={`/verkauf/rechnungen/${k.storno_von_id}`}>{k.storno_nummer}</Link></>
            )}
            {k.datev_uebergeben_am && <> · DATEV übergeben {date(k.datev_uebergeben_am)}</>}
            {k.probe && <> · zählt nicht in DATEV, Fälligkeiten und Umsatz; die gültige Rechnung kommt aus sevDesk</>}
          </>
        }
        actions={
          <>
            <a className="btn" href={`/api/verkauf/rechnung/${k.id}`} target="_blank" rel="noreferrer">
              PDF
            </a>
            {istRechnung && k.mahnstufe > 0 && (
              <a className="btn" href={`/api/verkauf/rechnung/${k.id}?art=mahnung`} target="_blank" rel="noreferrer">
                {mahntext} (PDF)
              </a>
            )}
            {k.status === 'offen' && !darfFinanzen && (
              <ActionButton className="primary" action={rechnungAlsBezahlt.bind(null, id)}>
                {istRechnung ? 'Als bezahlt markieren' : 'Als erstattet markieren'}
              </ActionButton>
            )}
            {istRechnung && k.status === 'offen' && k.ueberfaellig && k.mahnstufe < 3 && (
              <ActionButton action={rechnungMahnen.bind(null, id)}>
                {['Zahlungserinnerung', '1. Mahnung', '2. Mahnung'][Number(k.mahnstufe)]} erstellen
              </ActionButton>
            )}
          </>
        }
      />

      <Statusleiste prozessCode="kundenrechnung" art="kundenrechnung" zustand={k.status} />

      <div className="tiles" style={{ marginBottom: 12 }}>
        <div className="display-panel">
          <div className="display-head"><span>Anschrift</span></div>
          {anschrift.map((z) => <div key={z}>{z}</div>)}
          {k.kundennummer && <div className="small muted">Kundennummer {k.kundennummer}</div>}
        </div>
        <div className="display-panel">
          <div className="display-head"><span>Beleg</span></div>
          <div>Datum <span className="mono">{date(k.rechnungsdatum)}</span></div>
          <div>Lieferdatum <span className="mono">{date(k.leistungsdatum)}</span></div>
          {istRechnung && <div>Fällig <span className="mono">{date(k.faellig_am)}</span></div>}
          <div>Zahlungsart {k.zahlungsart ?? '—'}</div>
          {k.bezahlt_am && <div>{istRechnung ? 'Bezahlt' : 'Erstattet'} <span className="mono">{date(k.bezahlt_am)}</span></div>}
          {k.mahnstufe > 0 && <div>Mahnstufe {k.mahnstufe} ({mahntext}) am {date(k.gemahnt_am)}</div>}
          {k.ansprechpartner && <div className="small muted">Ansprechpartner {k.ansprechpartner}</div>}
          {k.grund && <div className="small muted">Grund: {k.grund}</div>}
        </div>
        <div className="display-panel">
          <div className="display-head"><span>Beträge</span></div>
          <div>Netto <span className="mono">{money(k.netto, k.waehrung)}</span></div>
          <div>Steuer <span className="mono">{money(k.steuer, k.waehrung)}</span></div>
          <div style={{ fontWeight: 650 }}>Brutto <span className="mono">{money(k.brutto, k.waehrung)}</span></div>
          {k.status === 'offen' && <div>Offen <span className="mono">{money(offen, k.waehrung)}</span></div>}
        </div>
      </div>

      <Card title="Positionen" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th className="num">Menge</th>
                <th className="num">Einzelpreis netto</th>
                <th className="num">Rabatt</th>
                <th className="num">MwSt.</th>
                <th className="num">Netto</th>
                <th className="num">Brutto</th>
              </tr>
            </thead>
            <tbody>
              {positionen.map((p) => (
                <tr key={p.id}>
                  <td>{p.bezeichnung}{Number(p.gutgeschrieben) > 0 && <span className="small muted"> · {qty(p.gutgeschrieben)} gutgeschrieben</span>}</td>
                  <td className="num">{qty(p.menge)} {p.einheit}</td>
                  <td className="num">{money(p.einzelpreis, k.waehrung)}</td>
                  <td className="num muted">{p.listenpreis != null ? `statt ${money(p.listenpreis, k.waehrung)}` : Number(p.rabatt_pct) > 0 ? `${qty(p.rabatt_pct)} %` : '—'}</td>
                  <td className="num">{qty(p.steuersatz)} %</td>
                  <td className="num">{money(p.netto, k.waehrung)}</td>
                  <td className="num">{money(p.brutto, k.waehrung)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="num mono-label">Netto</td>
                <td className="num">{money(k.netto, k.waehrung)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="num mono-label">Steuer</td>
                <td className="num">{money(k.steuer, k.waehrung)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="num mono-label">Brutto</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(k.brutto, k.waehrung)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      </Card>

      {gutschriften.length > 0 && (
        <Card title="Gutschriften zu diesem Beleg" tight>
          <TableWrap>
            <table>
              <thead>
                <tr><th>Nummer</th><th>Datum</th><th>Grund</th><th>Status</th><th className="num">Betrag</th></tr>
              </thead>
              <tbody>
                {gutschriften.map((g) => (
                  <tr key={g.id}>
                    <td className="mono"><Link href={`/verkauf/rechnungen/${g.id}`}>{g.nummer}</Link></td>
                    <td className="mono">{date(g.rechnungsdatum)}</td>
                    <td className="muted">{g.grund ?? '—'}</td>
                    <td><Badge state={g.status} kind="kundenrechnung" /></td>
                    <td className="num">− {money(g.brutto, k.waehrung)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {darfFinanzen && k.status === 'offen' && (
        <Card title={istRechnung ? 'Zahlungseingang' : 'Erstattung'}>
          <ActionForm action={rechnungZahlen.bind(null, id)}>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field shrink">
                <span>Betrag (€)</span>
                <input type="number" name="betrag" step="0.01" min="0.01" defaultValue={offen.toFixed(2)} required style={{ width: 130 }} />
              </label>
              <label className="field shrink">
                <span>Datum</span>
                <input type="date" name="datum" defaultValue={isoDatum(new Date())} />
              </label>
              <label className="field shrink">
                <span>Bankkonto</span>
                <Auswahl name="bankkonto_id" defaultValue="">
                  <option value="">—</option>
                  {konten.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Auswahl>
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">{istRechnung ? 'Zahlung erfassen' : 'Erstattung erfassen'}</button>
              </div>
              <div className="shrink field">
                <ActionButton action={rechnungAlsBezahlt.bind(null, id)}>
                  {istRechnung ? 'Nur als bezahlt markieren' : 'Nur als erstattet markieren'}
                </ActionButton>
              </div>
            </div>
          </ActionForm>
          {zahlungen.length > 0 && (
            <TableWrap>
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Zahlung</th><th>Datum</th><th>Konto</th><th className="num">Betrag</th><th /></tr></thead>
                <tbody>
                  {zahlungen.map((z) => (
                    <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                      <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                      <td className="mono">{date(z.gezahlt_am)}</td>
                      <td className="muted">{z.konto ?? '—'}</td>
                      <td className="num">{money(z.betrag_eur)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {!z.storniert && (
                          <ActionButton className="small danger" action={zahlungStornieren.bind(null, z.id)}>Stornieren</ActionButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {darfFinanzen && k.status === 'bezahlt' && zahlungen.length > 0 && (
        <Card title="Zahlungen" tight>
          <TableWrap>
            <table>
              <thead><tr><th>Zahlung</th><th>Datum</th><th>Konto</th><th className="num">Betrag</th><th /></tr></thead>
              <tbody>
                {zahlungen.map((z) => (
                  <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                    <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                    <td className="mono">{date(z.gezahlt_am)}</td>
                    <td className="muted">{z.konto ?? '—'}</td>
                    <td className="num">{money(z.betrag_eur)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!z.storniert && (
                        <ActionButton className="small danger" action={zahlungStornieren.bind(null, z.id)}>Stornieren</ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {istRechnung && k.status !== 'storniert' && (
        <Card title="Korrektur">
          <p className="small muted" style={{ marginTop: 0 }}>
            Ein Beleg wird nie geändert, nur durch einen neuen korrigiert: die <strong>Teilgutschrift</strong> nimmt
            einzelne Mengen zurück (Rücknahme, Nachlass), das <strong>Storno</strong> hebt die ganze Rechnung durch eine
            Gutschrift auf. Für eine geänderte Lieferung entsteht danach eine neue Rechnung aus der Lieferung.
          </p>
          <ActionForm action={gutschriftErstellen.bind(null, id)}>
            <TableWrap>
              <table>
                <thead><tr><th>Position</th><th className="num">Berechnet</th><th className="num">Gutschreiben</th></tr></thead>
                <tbody>
                  {positionen.map((p) => (
                    <tr key={p.id}>
                      <td>{p.bezeichnung}</td>
                      <td className="num">{qty(p.menge)} {p.einheit}</td>
                      <td className="num">
                        <input
                          type="number"
                          name={`gut_${p.id}`}
                          step="0.01"
                          min="0"
                          max={Math.max(Number(p.menge) - Number(p.gutgeschrieben), 0)}
                          placeholder="0"
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="row" style={{ alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: 2 }}>
                <span>Grund</span>
                <input name="grund" placeholder="z. B. Rücknahme, Preisnachlass" />
              </label>
              <div className="shrink field">
                <button type="submit">Teilgutschrift erstellen</button>
              </div>
            </div>
          </ActionForm>
          <div style={{ marginTop: 12 }}>
            <ActionForm action={rechnungStornieren.bind(null, id)}>
              <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="field" style={{ flex: 2 }}>
                  <span>Storno-Grund</span>
                  <input name="grund" placeholder="z. B. Bestellung storniert" />
                </label>
                <div className="shrink field">
                  <button className="danger" type="submit">Rechnung stornieren (Gutschrift über alles)</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>
      )}

      {k.status === 'offen' && (
        <Card title="Belegdaten">
          <ActionForm action={rechnungDetails.bind(null, id)}>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: 3 }}>
                <span>Notiz auf dem Beleg</span>
                <input name="notiz" defaultValue={k.notiz ?? ''} />
              </label>
              {istRechnung && (
                <label className="field shrink">
                  <span>Fällig am</span>
                  <input type="date" name="faellig_am" defaultValue={k.faellig_am ?? ''} />
                </label>
              )}
              <div className="shrink field">
                <button type="submit">Speichern</button>
              </div>
            </div>
          </ActionForm>
        </Card>
      )}

      <RecordComments model="kundenrechnung" recordId={id} path={`/verkauf/rechnungen/${id}`} />
    </>
  )
}
