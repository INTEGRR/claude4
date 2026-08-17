import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { ActionForm } from '@/components/action-button'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { date, money } from '@/modules/shared/format'
import { vertragZahlen } from '../../actions'

export const dynamic = 'force-dynamic'

/** Vertragsdetail: Stammdaten, Kündigungslage, künftige Termine, Zahlungen. */
export default async function VertragSeite({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('finanzen')
  const { id } = await params

  const [v] = await sql<
    { id: string; nummer: string; name: string; kategorie: string; partner: string | null;
      betrag: number; waehrung: string; intervall: string; zahltag: number;
      beginn: string; ende: string | null; laufzeit_monate: number | null;
      kuendigungsfrist_monate: number; gekuendigt_am: string | null;
      gekuendigt_zum: string | null; status: string; notiz: string | null;
      kuendbar_zum: string | null; frist_bis: string | null; ansteht: boolean }[]
  >`
    select v.*, p.name as partner,
           vertrag_naechstes_kuendbar_zum(v)::text as kuendbar_zum,
           vertrag_kuendigungsfrist_bis(v)::text as frist_bis,
           vertrag_kuendigung_ansteht(v.id) as ansteht
    from vertraege v
    left join partners p on p.id = v.partner_id
    where v.id = ${id}`
  if (!v) notFound()

  const termine = await sql<{ faellig_am: string; betrag_eur: number }[]>`
    select * from vertrag_zahlungen_bis(${id}, current_date + 370)`

  const zahlungen = await sql<
    { id: string; nummer: string; betrag_eur: number; gezahlt_am: string;
      konto: string | null; storniert: boolean }[]
  >`
    select z.id, z.nummer, z.betrag_eur, z.gezahlt_am, k.name as konto,
           (z.storniert_am is not null) as storniert
    from zahlungen z
    left join bankkonten k on k.id = z.bankkonto_id
    where z.vertrag_id = ${id}
    order by z.gezahlt_am desc`

  const konten = await sql<{ id: string; name: string }[]>`
    select id, name from bankkonten where aktiv order by sequence, name`

  return (
    <>
      <PageHeader
        title={`${v.nummer} — ${v.name}`}
        subtitle={`${v.kategorie} · ${money(v.betrag, v.waehrung)} ${v.intervall} · Zahltag ${v.zahltag}.`}
        actions={
          <Link className="btn small" href={`/aktion/finanzen.vertrag_aendern`}>
            Ändern
          </Link>
        }
      />

      {v.status === 'aktiv' && v.ansteht && (
        <div className="notice wichtig">
          <span className="led wichtig" />{' '}
          <strong>Kündigungsfrist läuft ab:</strong> kündbar zum{' '}
          <span className="mono">{date(v.kuendbar_zum!)}</span> — die Kündigung muss bis{' '}
          <span className="mono">{date(v.frist_bis!)}</span> raus, sonst verlängert sich der
          Vertrag um {v.laufzeit_monate} Monate.
        </div>
      )}
      {v.status === 'gekuendigt' && (
        <div className="notice info">
          Gekündigt am {date(v.gekuendigt_am!)} zum {date(v.gekuendigt_zum!)}.
        </div>
      )}

      {/* Der Prozess trägt Anlegen/Kündigen — inklusive Torwächter und Maske. */}
      <ProzessPanel
        prozessCode="vertrag_fixkosten"
        recordId={id}
        rolle={user.role}
        befugnisse={user.befugnisse}
      />

      <div className="grid-2">
        <Card title="Konditionen">
          <TableWrap>
            <table>
              <tbody>
                <tr><td className="mono-label">Partner</td><td>{v.partner ?? '—'}</td></tr>
                <tr><td className="mono-label">Beginn</td><td className="mono">{date(v.beginn)}</td></tr>
                <tr>
                  <td className="mono-label">Ende</td>
                  <td className="mono">{v.ende ? date(v.ende) : 'unbefristet'}</td>
                </tr>
                <tr>
                  <td className="mono-label">Mindestlaufzeit</td>
                  <td>{v.laufzeit_monate ? `${v.laufzeit_monate} Monate (rollierend)` : '—'}</td>
                </tr>
                <tr>
                  <td className="mono-label">Kündigungsfrist</td>
                  <td>{v.kuendigungsfrist_monate} Monate</td>
                </tr>
                {v.status === 'aktiv' && v.kuendbar_zum && (
                  <tr>
                    <td className="mono-label">Kündbar zum</td>
                    <td className="mono">
                      {date(v.kuendbar_zum)}{' '}
                      <span className="muted small">(Frist bis {date(v.frist_bis!)})</span>
                    </td>
                  </tr>
                )}
                {v.notiz && <tr><td className="mono-label">Notiz</td><td>{v.notiz}</td></tr>}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <Card title="Nächste Zahlungen (12 Monate)">
          {termine.length === 0 ? (
            <Empty>Keine künftigen Zahlungen (Vertrag endet oder ist beendet).</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr><th>Fällig am</th><th style={{ textAlign: 'right' }}>Betrag</th></tr>
                </thead>
                <tbody>
                  {termine.slice(0, 8).map((z) => (
                    <tr key={z.faellig_am}>
                      <td className="mono muted">{date(z.faellig_am)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(z.betrag_eur)}</td>
                    </tr>
                  ))}
                  {termine.length > 8 && (
                    <tr>
                      <td className="muted" colSpan={2}>… {termine.length - 8} weitere</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Zahlungen">
        {zahlungen.length > 0 && (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Zahlung</th><th>Datum</th><th>Konto</th>
                  <th style={{ textAlign: 'right' }}>Betrag</th>
                </tr>
              </thead>
              <tbody>
                {zahlungen.map((z) => (
                  <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                    <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                    <td className="mono muted">{date(z.gezahlt_am)}</td>
                    <td className="muted">{z.konto ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(z.betrag_eur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {v.status !== 'beendet' && (
          <div style={{ marginTop: zahlungen.length > 0 ? 12 : 0 }}>
            <ActionForm action={vertragZahlen.bind(null, id)}>
              <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="field shrink">
                  <span>Gezahlt am</span>
                  <input type="date" name="gezahlt_am" defaultValue={new Date().toISOString().slice(0, 10)} />
                </label>
                <label className="field shrink">
                  <span>Bankkonto</span>
                  <select name="bankkonto_id" defaultValue="">
                    <option value="">—</option>
                    {konten.map((k) => (
                      <option key={k.id} value={k.id}>{k.name}</option>
                    ))}
                  </select>
                </label>
                <div className="shrink field">
                  <button className="small" type="submit">
                    {money(v.betrag, v.waehrung)} als bezahlt erfassen
                  </button>
                </div>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      <RecordComments model="vertrag" recordId={id} path={`/finanzen/vertraege/${id}`} />
    </>
  )
}
