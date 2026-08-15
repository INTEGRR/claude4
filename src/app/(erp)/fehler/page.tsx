import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { fehlerMelden } from './actions'

export const dynamic = 'force-dynamic'

const SCHWERE_BADGE: Record<string, string> = {
  kritisch: 'danger',
  stoerend: 'warn',
  kosmetisch: 'neutral',
}

const STATUS_BADGE: Record<string, string> = {
  offen: 'warn',
  in_arbeit: 'info',
  behoben: 'success',
  verworfen: 'neutral',
}

export default async function FehlerPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  await requireArea('fehler')
  const params = await searchParams
  // Standardsicht: was noch Arbeit bedeutet. Erledigtes auf Wunsch.
  const filter = params.status ?? 'offen'
  const status =
    filter === 'alle'
      ? ['offen', 'in_arbeit', 'behoben', 'verworfen']
      : filter === 'erledigt'
        ? ['behoben', 'verworfen']
        : ['offen', 'in_arbeit']

  const meldungen = await sql<
    {
      id: string
      number: string
      titel: string
      seite: string | null
      schwere: string
      status: string
      gemeldet_von: string
      created_at: string
    }[]
  >`
    select id, number, titel, seite, schwere, status, gemeldet_von, created_at
    from bug_reports
    where status = any(${status}::bug_status[])
    order by created_at desc
    limit 200`

  return (
    <>
      <PageHeader
        title="Fehler melden"
        subtitle="Direkt in die Datenbank — die Entwicklung arbeitet die Liste auf Zuruf ab"
      />

      <Card title="Neuen Fehler melden">
        <ActionForm action={fehlerMelden}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Was geht schief? (kurz)</span>
              <input name="titel" required maxLength={200} placeholder="z. B. Label-Druck bricht bei Umlauten ab" />
            </label>
            <label className="field shrink">
              <span>Schwere</span>
              <select name="schwere" defaultValue="stoerend">
                <option value="kritisch">kritisch — blockiert die Arbeit</option>
                <option value="stoerend">störend — Umweg nötig</option>
                <option value="kosmetisch">kosmetisch</option>
              </select>
            </label>
            <label className="field shrink">
              <span>Seite (Pfad)</span>
              <input className="mono" name="seite" placeholder="/versand" style={{ width: 140 }} />
            </label>
          </div>
          <label className="field">
            <span>Was ist passiert, was hast du erwartet? Schritt für Schritt hilft am meisten.</span>
            <textarea name="beschreibung" rows={3} maxLength={4000} />
          </label>
          <button className="primary" type="submit">Melden</button>
        </ActionForm>
      </Card>

      <Card title={`Meldungen (${meldungen.length})`} tight>
        <div className="row" style={{ padding: '10px 12px 0', gap: 6 }}>
          {[
            ['offen', 'Offen'],
            ['erledigt', 'Erledigt'],
            ['alle', 'Alle'],
          ].map(([wert, text]) => (
            <div className="shrink" key={wert}>
              <Link
                className={`btn small${filter === wert ? ' primary' : ''}`}
                href={wert === 'offen' ? '/fehler' : `/fehler?status=${wert}`}
              >
                {text}
              </Link>
            </div>
          ))}
        </div>
        {meldungen.length === 0 ? (
          <Empty>Keine Meldungen — so soll es sein.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Titel</th>
                  <th>Seite</th>
                  <th>Schwere</th>
                  <th>Status</th>
                  <th>Gemeldet</th>
                </tr>
              </thead>
              <tbody>
                {meldungen.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">
                      <Link href={`/fehler/${m.id}`}>{m.number}</Link>
                    </td>
                    <td>
                      <Link href={`/fehler/${m.id}`}>{m.titel}</Link>
                    </td>
                    <td className="mono small">{m.seite ?? '—'}</td>
                    <td>
                      <span className={`badge ${SCHWERE_BADGE[m.schwere] ?? ''}`}>{m.schwere}</span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[m.status] ?? ''}`}>
                        {m.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="small nowrap">
                      {m.gemeldet_von} · <span className="mono">{dateTime(m.created_at)}</span>
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
