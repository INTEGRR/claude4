import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { ActionForm } from '@/components/action-button'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { date, isoDatum, money } from '@/modules/shared/format'
import { vertragAendern, vertragZahlen } from '../../actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

/** Vertragsdetail: Stammdaten, Kündigungslage, künftige Termine, Zahlungen. */
export default async function VertragSeite({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('finanzen')
  const { id } = await params

  const [v] = await sql<
    { id: string; nummer: string; name: string; kategorie: string; partner_id: string | null; partner: string | null;
      betrag: number; waehrung: string; intervall: string; zahltag: number;
      beginn: string; ende: string | null; laufzeit_monate: number | null;
      kuendigungsfrist_monate: number; gekuendigt_am: string | null;
      gekuendigt_zum: string | null; status: string; notiz: string | null;
      kuendbar_zum: string | null; frist_bis: string | null; ansteht: boolean;
      beginn_iso: string; ende_iso: string | null }[]
  >`
    select v.*, p.name as partner, v.beginn::text as beginn_iso, v.ende::text as ende_iso,
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

  // Für „Ändern": Kategorien aus den Finanz-Einstellungen, Partner zur Auswahl.
  const [einstellung] = await sql<{ kategorien: string[] | null }[]>`
    select array(select jsonb_array_elements_text(value -> 'vertrag_kategorien')) as kategorien
    from settings where key = 'finanzen'`
  const kategorien = [...new Set([...(einstellung?.kategorien ?? []), v.kategorie])]
  const partner = await sql<{ id: string; name: string }[]>`
    select id, name from partners where active or id = ${v.partner_id} order by name limit 1000`

  return (
    <>
      <PageHeader
        title={`${v.nummer} — ${v.name}`}
        subtitle={`${v.kategorie} · ${money(v.betrag, v.waehrung)} ${v.intervall} · Zahltag ${v.zahltag}.`}
      />

      {/* Ändern direkt am Vertrag — die generierte Maske (/aktion) kennt nur
          belegfreie Aktionen; geschrieben wird über den Torwächter. */}
      <details className="card" style={{ padding: '10px 14px' }}>
        <summary className="mono-label" style={{ cursor: 'pointer' }}>Vertrag ändern</summary>
        <ActionForm action={vertragAendern.bind(null, id)} style={{ marginTop: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 2 }}>
              <span>Bezeichnung</span>
              <input name="name" required maxLength={160} defaultValue={v.name} />
            </label>
            <label className="field shrink">
              <span>Kategorie</span>
              <Auswahl name="kategorie" defaultValue={v.kategorie}>
                {kategorien.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </Auswahl>
            </label>
            <label className="field" style={{ flex: 1.5 }}>
              <span>Partner</span>
              <Auswahl name="partner_id" defaultValue={v.partner_id ?? ''}>
                <option value="">—</option>
                {partner.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Auswahl>
            </label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="field shrink">
              <span>Betrag</span>
              <input name="betrag" type="number" required min={0.01} step={0.01} defaultValue={Number(v.betrag)} style={{ width: 120 }} />
            </label>
            <label className="field shrink">
              <span>Währung</span>
              <input name="waehrung" required maxLength={3} defaultValue={v.waehrung} style={{ width: 70 }} />
            </label>
            <label className="field shrink">
              <span>Intervall</span>
              <Auswahl name="intervall" defaultValue={v.intervall}>
                <option value="monatlich">monatlich</option>
                <option value="quartalsweise">quartalsweise</option>
                <option value="jaehrlich">jährlich</option>
              </Auswahl>
            </label>
            <label className="field shrink">
              <span>Zahltag</span>
              <input name="zahltag" type="number" required min={1} max={28} step={1} defaultValue={v.zahltag} style={{ width: 70 }} />
            </label>
            <label className="field shrink">
              <span>Beginn</span>
              <input name="beginn" type="date" required defaultValue={v.beginn_iso} />
            </label>
            <label className="field shrink">
              <span>Ende</span>
              <input name="ende" type="date" defaultValue={v.ende_iso ?? ''} />
            </label>
            <label className="field shrink">
              <span>Mindestlaufzeit (Monate)</span>
              <input name="laufzeit_monate" type="number" min={1} step={1} defaultValue={v.laufzeit_monate ?? ''} style={{ width: 90 }} />
            </label>
            <label className="field shrink">
              <span>Kündigungsfrist (Monate)</span>
              <input name="kuendigungsfrist_monate" type="number" required min={0} max={24} step={1} defaultValue={v.kuendigungsfrist_monate} style={{ width: 90 }} />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Notiz</span>
              <input name="notiz" maxLength={500} defaultValue={v.notiz ?? ''} />
            </label>
            <div className="field shrink">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
      </details>

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
        rolle={user.rollen}
        befugnisse={user.befugnisse}
      />

      <div className="grid-2">
        <Card title="Konditionen">
          <TableWrap>
            <table>
              <tbody>
                <tr>
                  <td className="mono-label">Partner</td>
                  <td>{v.partner_id ? <Link href={`/kontakte/${v.partner_id}`}>{v.partner}</Link> : '—'}</td>
                </tr>
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
                  <input type="date" name="gezahlt_am" defaultValue={isoDatum(new Date())} />
                </label>
                <label className="field shrink">
                  <span>Bankkonto</span>
                  <Auswahl name="bankkonto_id" defaultValue="">
                    <option value="">—</option>
                    {konten.map((k) => (
                      <option key={k.id} value={k.id}>{k.name}</option>
                    ))}
                  </Auswahl>
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
