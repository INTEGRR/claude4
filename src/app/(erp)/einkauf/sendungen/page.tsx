import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { SENDUNG_MODI, type SendungModus } from '@/modules/einkauf/sendungen'
import { date } from '@/modules/shared/format'
import { sendungAnlegen } from './actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'laufend', label: 'Laufend', filter: ['geplant', 'verschifft', 'verzollt', 'angekommen'] },
  { key: 'abgerechnet', label: 'Abgerechnet', filter: ['abgerechnet'] },
  { key: 'storniert', label: 'Storniert', filter: ['storniert'] },
  { key: 'alle', label: 'Alle', filter: ['geplant', 'verschifft', 'verzollt', 'angekommen', 'abgerechnet', 'storniert'] },
] as const

/**
 * Eingangssendungen (0108): Sammelfracht mit einer oder mehreren
 * Bestellungen — K+N See/Luft oder Express vom Lieferanten. Je Sendung
 * Frachtpapiere, Zoll, Kosten und ihre Verteilung auf die Wareneingänge.
 */
export default async function SendungenPage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const { ansicht: roh } = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === roh) ?? ANSICHTEN[0]

  const [rows, bestellungen, spediteure] = await Promise.all([
    sql<
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
        etd: string | null
        eta: string | null
        bestellungen: { id: string; number: string; partner_id: string; lieferant: string }[]
      }[]
    >`
      select s.id, s.nummer, s.bezeichnung, s.status::text as status, s.modus, s.spediteur_id, sp.name as spediteur,
             s.traeger, s.hbl_awb, s.etd::text as etd, s.eta::text as eta,
             coalesce((select jsonb_agg(jsonb_build_object('id', po.id, 'number', po.number, 'partner_id', pa.id, 'lieferant', pa.name)
                                        order by po.number)
                       from eingangs_sendung_bestellungen b
                       join purchase_orders po on po.id = b.purchase_order_id
                       join partners pa on pa.id = po.vendor_id
                       where b.sendung_id = s.id), '[]'::jsonb) as bestellungen
      from eingangs_sendungen s
      left join partners sp on sp.id = s.spediteur_id
      where s.status = any(${ansicht.filter as unknown as string[]}::eingangs_sendung_status[])
      order by coalesce(s.eta, s.etd) nulls last, s.created_at desc
      limit 300`,
    // Bestätigte Bestellungen mit offenem Wareneingang, der noch an keiner Sendung hängt.
    sql<{ id: string; label: string }[]>`
      select po.id, po.number || ' · ' || pa.name || coalesce(' · ETA ' || to_char(coalesce(po.eta_confirmed, po.expected_arrival::date), 'DD.MM.'), '') as label
      from purchase_orders po
      join partners pa on pa.id = po.vendor_id
      where po.state = 'purchase'
        and exists (select 1 from stock_pickings sp
                    where sp.origin_model = 'purchase_order' and sp.origin_id = po.id
                      and sp.state not in ('done', 'cancel') and sp.eingangs_sendung_id is null)
      order by po.created_at desc
      limit 100`,
    sql<{ id: string; name: string }[]>`select id, name from partners where is_vendor and active order by lower(name) limit 500`,
  ])

  return (
    <>
      <PageHeader
        title="Sendungen & Zoll"
        subtitle="Sammelfracht mit mehreren Bestellungen — Verschiffung, Zoll, Kosten als Landed Costs auf die Wareneingänge, EUSt getrennt"
        actions={
          <Link className="btn" href="/einkauf/cockpit">
            Cockpit
          </Link>
        }
      />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/sendungen?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Sendungen in dieser Ansicht.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendung</th>
                  <th>Modus / Spediteur</th>
                  <th>Bestellungen</th>
                  <th>ETD</th>
                  <th>ETA</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/einkauf/sendungen/${s.id}`}>
                        <span className="mono">{s.nummer}</span>
                        {s.bezeichnung ? ` ${s.bezeichnung}` : ''}
                      </Link>
                      {s.hbl_awb && <div className="muted small mono">{s.hbl_awb}</div>}
                    </td>
                    <td className="small">
                      {SENDUNG_MODI[s.modus] ?? s.modus}
                      {s.spediteur_id ? (
                        <>
                          {' · '}
                          <Link href={`/einkauf/lieferanten/${s.spediteur_id}`}>{s.spediteur}</Link>
                        </>
                      ) : s.traeger ? (
                        ` · ${s.traeger}`
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="small">
                      {s.bestellungen.length === 0
                        ? '—'
                        : s.bestellungen.map((b, i) => (
                            <span key={b.id}>
                              {i > 0 && ', '}
                              <Link className="mono" href={`/einkauf/${b.id}`}>
                                {b.number}
                              </Link>{' '}
                              (<Link href={`/einkauf/lieferanten/${b.partner_id}`}>{b.lieferant}</Link>)
                            </span>
                          ))}
                    </td>
                    <td className="small nowrap">{date(s.etd)}</td>
                    <td className="small nowrap">{date(s.eta)}</td>
                    <td>
                      <Badge state={s.status} kind="eingangs_sendung" href={`/einkauf/sendungen/${s.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darf && (
        <Card title="Neue Sendung">
          <ActionForm action={sendungAnlegen}>
            <div className="row">
              <label className="field" style={{ flex: 2 }}>
                <span>Bezeichnung</span>
                <input name="bezeichnung" placeholder="z. B. LCL Shenzhen KW 41" />
              </label>
              <label className="field shrink">
                <span>Modus</span>
                <Auswahl name="modus" defaultValue="see">
                  {Object.entries(SENDUNG_MODI).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Spediteur</span>
                <Auswahl name="spediteur_id" defaultValue="">
                  <option value="">— (Express: Kurier des Lieferanten)</option>
                  {spediteure.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Auswahl>
              </label>
              <label className="field">
                <span>Träger</span>
                <input name="traeger" placeholder="Reederei, Airline oder Kurier" />
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>HBL / AWB</span>
                <input name="hbl_awb" className="mono" />
              </label>
              <label className="field">
                <span>Container</span>
                <input name="container" className="mono" />
              </label>
              <label className="field shrink">
                <span>ETD</span>
                <input type="date" name="etd" />
              </label>
              <label className="field shrink">
                <span>ETA</span>
                <input type="date" name="eta" />
              </label>
              <label className="field shrink">
                <span>kg brutto</span>
                <input name="gewicht_kg" inputMode="decimal" />
              </label>
              <label className="field shrink">
                <span>cbm</span>
                <input name="volumen_cbm" inputMode="decimal" />
              </label>
              <label className="field shrink">
                <span>Packstücke</span>
                <input name="packstuecke" inputMode="numeric" />
              </label>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: '6px 0 10px' }}>
              <legend className="mono-label" style={{ marginBottom: 6 }}>
                Bestellungen (offener Wareneingang, noch ohne Sendung)
              </legend>
              {bestellungen.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  Keine offenen Bestellungen ohne Sendung — Nummern lassen sich unten auch eintippen.
                </p>
              ) : (
                <div className="row" style={{ flexWrap: 'wrap', gap: '4px 16px' }}>
                  {bestellungen.map((b) => (
                    <label key={b.id} className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" name="bestellung" value={b.id} /> {b.label}
                    </label>
                  ))}
                </div>
              )}
              <label className="field" style={{ marginTop: 8 }}>
                <span>Weitere Bestellnummern</span>
                <input name="bestellnummern" className="mono" placeholder="P00042, P00043" />
              </label>
            </fieldset>
            <button className="primary" type="submit">
              Sendung anlegen
            </button>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Die Wareneingänge der Bestellungen hängen danach an der Sendung. „Verschifft" schreibt den Tag an die
              Bestellungen — Zahlplan-Raten „bei Verschiffung" werden damit fällig.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
