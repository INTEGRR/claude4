import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { VERTRAG_ARTEN, type VertragStatus, vertragsLage } from '@/modules/einkauf/lieferantenvertraege'
import { date } from '@/modules/shared/format'
import { vertragAnlegen } from './actions'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ANSICHTEN = [
  { key: 'aktiv', label: 'Aktiv', filter: ['aktiv'] },
  { key: 'gekuendigt', label: 'Gekündigt', filter: ['gekuendigt'] },
  { key: 'beendet', label: 'Beendet', filter: ['beendet'] },
  { key: 'alle', label: 'Alle', filter: ['aktiv', 'gekuendigt', 'beendet'] },
] as const

/**
 * Lieferantenverträge (0107): NDA, QSV, Rahmenverträge und Preislisten mit
 * Laufzeit und Kündigungsfrist. Was bald ausläuft, steht oben und erscheint
 * als Wiedervorlage. Nicht die Fixkosten-Verträge der Finanzen.
 */
export default async function VertraegePage({
  searchParams,
}: {
  searchParams: Promise<{ ansicht?: string; lieferant?: string }>
}) {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const sp = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === sp.ansicht) ?? ANSICHTEN[0]
  const vorLieferant = sp.lieferant && UUID.test(sp.lieferant) ? sp.lieferant : ''
  const heute = new Date().toISOString().slice(0, 10)

  const [rows, lieferanten, waehrungen] = await Promise.all([
    sql<
      {
        id: string
        art: keyof typeof VERTRAG_ARTEN
        titel: string
        status: VertragStatus
        gueltig_von: string | null
        gueltig_bis: string | null
        ende: string | null
        stichtag: string | null
        kuendigungsfrist_monate: number
        verlaengerung_monate: number | null
        erinnerung_tage: number
        partner_id: string
        lieferant: string
        preise: number
      }[]
    >`
      select v.id, v.art::text as art, v.titel, v.status::text as status, v.gueltig_von::text as gueltig_von,
             v.gueltig_bis::text as gueltig_bis, lieferantenvertrag_ende(v)::text as ende,
             lieferantenvertrag_stichtag(v)::text as stichtag, v.kuendigungsfrist_monate, v.verlaengerung_monate,
             v.erinnerung_tage, pa.id as partner_id, pa.name as lieferant,
             (select count(*)::int from vendor_prices vp where vp.vertrag_id = v.id) as preise
      from lieferantenvertraege v join partners pa on pa.id = v.partner_id
      where v.status = any(${ansicht.filter as unknown as string[]}::lieferantenvertrag_status[])
        and (${vorLieferant || null}::uuid is null or v.partner_id = ${vorLieferant || null}::uuid)
      order by lieferantenvertrag_stichtag(v) nulls last, pa.name, v.titel
      limit 500`,
    sql<{ id: string; name: string }[]>`select id, name from partners where is_vendor and active order by lower(name) limit 500`,
    sql<{ code: string }[]>`select code from currencies where active order by code = 'EUR' desc, code`,
  ])

  return (
    <>
      <PageHeader
        title="Lieferantenverträge"
        subtitle="NDA, Qualitätssicherung, Rahmenverträge und Preislisten — mit Laufzeit, Frist und Erinnerung"
      />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/vertraege?ansicht=${a.key}${vorLieferant ? `&lieferant=${vorLieferant}` : ''}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
          {vorLieferant && (
            <Link className="btn small" href={`/einkauf/vertraege?ansicht=${ansicht.key}`}>
              alle Lieferanten
            </Link>
          )}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Verträge in dieser Ansicht.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Vertrag</th>
                  <th>Lieferant</th>
                  <th>Laufzeit</th>
                  <th>Kündigen bis</th>
                  <th className="num">Preise</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const lage = vertragsLage(v, heute)
                  return (
                    <tr key={v.id}>
                      <td>
                        <Link href={`/einkauf/vertraege/${v.id}`}>{v.titel}</Link>
                        <div className="muted small">{VERTRAG_ARTEN[v.art]}</div>
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/lieferanten/${v.partner_id}`}>{v.lieferant}</Link>
                      </td>
                      <td className="small nowrap">
                        {v.gueltig_von ? date(v.gueltig_von) : 'offen'} – {v.ende ? date(v.ende) : 'unbefristet'}
                        {v.verlaengerung_monate && v.status === 'aktiv' && (
                          <div className="muted">verlängert sich um {v.verlaengerung_monate} Monate</div>
                        )}
                      </td>
                      <td className={`small nowrap${lage === 'faellig' || lage === 'abgelaufen' ? ' wv-ueberfaellig' : ''}`}>
                        {v.status === 'aktiv' && v.stichtag ? date(v.stichtag) : '—'}
                        {v.kuendigungsfrist_monate > 0 && <div className="muted">{v.kuendigungsfrist_monate} Monate Frist</div>}
                      </td>
                      <td className="num small">
                        {v.preise > 0 ? <Link href={`/einkauf/vertraege/${v.id}#preise`}>{v.preise}</Link> : '—'}
                      </td>
                      <td>
                        <Badge state={lage} kind="lieferantenvertrag" href={`/einkauf/vertraege/${v.id}`} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {darf && (
        <Card title="Neuer Vertrag">
          <ActionForm action={vertragAnlegen}>
            <div className="row">
              <label className="field">
                <span>Lieferant</span>
                <select name="partner_id" required defaultValue={vorLieferant}>
                  <option value="" disabled>
                    — wählen —
                  </option>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Art</span>
                <select name="art" defaultValue="nda">
                  {Object.entries(VERTRAG_ARTEN).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Titel</span>
                <input name="titel" required placeholder="z. B. Rahmenvertrag Keycaps 2026/27" />
              </label>
            </div>
            <div className="row">
              <label className="field shrink">
                <span>Gültig von</span>
                <input type="date" name="gueltig_von" />
              </label>
              <label className="field shrink">
                <span>Gültig bis (leer = unbefristet)</span>
                <input type="date" name="gueltig_bis" />
              </label>
              <label className="field shrink">
                <span>Kündigungsfrist (Monate)</span>
                <input name="kuendigungsfrist_monate" inputMode="numeric" placeholder="0" />
              </label>
              <label className="field shrink">
                <span>Verlängert sich um (Monate)</span>
                <input name="verlaengerung_monate" inputMode="numeric" placeholder="—" />
              </label>
              <label className="field shrink">
                <span>Erinnern (Tage vorher)</span>
                <input name="erinnerung_tage" inputMode="numeric" defaultValue="30" />
              </label>
              <label className="field shrink">
                <span>Währung der Preise</span>
                <select name="waehrung" defaultValue="" className="mono">
                  <option value="">wie Lieferant</option>
                  {waehrungen.map((w) => (
                    <option key={w.code} value={w.code}>
                      {w.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Notiz</span>
              <textarea name="notiz" rows={2} />
            </label>
            <button className="primary" type="submit">
              Vertrag anlegen
            </button>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Die Vertragsdatei hängt danach als Dokument am Vertrag. Wiedervorlage: Laufzeitende − Kündigungsfrist −
              Erinnerung (Standard 30 Tage) — sie verschwindet, sobald der Vertrag verlängert, gekündigt oder beendet ist.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
