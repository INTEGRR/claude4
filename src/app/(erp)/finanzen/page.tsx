import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Finanzen, Ausbaustufe 1: der Kassenstand. Salden je Bankkonto (manueller
 * Anker + erfasste Zahlungen), was in den nächsten zwei Wochen fällig ist,
 * und das Zahlungsregister. Prognose, Verträge, Darlehen und Steuern folgen
 * in den nächsten Ausbaustufen — die Karten hier sind ihr Fundament.
 */
export default async function FinanzenSeite() {
  await requireArea('finanzen')

  const salden = await sql<
    { bankkonto_id: string | null; name: string; saldo: number; stichtag: string | null }[]
  >`select * from finanz_saldo()`
  const gesamt = salden.reduce((s, k) => s + Number(k.saldo), 0)

  const faellig = await sql<
    { quelle: string; ref: string; label: string; partner: string | null;
      faellig_am: string; betrag_eur: number; richtung: string; link: string }[]
  >`select * from finanz_faellig(current_date + 14)`
  const faelligSumme = faellig.reduce((s, f) => s + Number(f.betrag_eur), 0)
  const ueberfaellig = faellig.filter((f) => new Date(f.faellig_am) < new Date())

  const zahlungen = await sql<
    { id: string; nummer: string; richtung: string; betrag_eur: number; gezahlt_am: string;
      quelle: string; verwendungszweck: string | null; partner: string | null;
      konto: string | null; storniert: boolean }[]
  >`
    select z.id, z.nummer, z.richtung, z.betrag_eur, z.gezahlt_am, z.quelle,
           z.verwendungszweck, p.name as partner, k.name as konto,
           (z.storniert_am is not null) as storniert
    from zahlungen z
    left join partners p on p.id = z.partner_id
    left join bankkonten k on k.id = z.bankkonto_id
    order by z.gezahlt_am desc, z.created_at desc
    limit 15`

  return (
    <>
      <PageHeader
        title="Finanzen"
        subtitle="Kassenstand, fällige Zahlungen, Register"
        actions={
          <>
            <Link className="btn small" href="/aktion/finanzen.bankkonto_anlegen">
              Bankkonto anlegen
            </Link>
            <Link className="btn small" href="/aktion/finanzen.kontostand_erfassen">
              Kontostand erfassen
            </Link>
            <Link className="btn small" href="/aktion/finanzen.zahlung_erfassen">
              Zahlung erfassen
            </Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Kassenstand gesamt" value={money(gesamt)} />
        <Stat
          label="Fällig in 14 Tagen"
          value={money(faelligSumme)}
          hint={`${faellig.length} Posten`}
        />
        <Stat
          label="Überfällig"
          value={money(ueberfaellig.reduce((s, f) => s + Number(f.betrag_eur), 0))}
          hint={ueberfaellig.length > 0 ? `${ueberfaellig.length} Posten` : 'nichts'}
        />
      </div>

      <div className="grid-2">
        <Card title="Bankkonten">
          {salden.length === 0 ? (
            <Empty>
              Noch kein Bankkonto — mit „Bankkonto anlegen" starten, dann den Kontostand
              als Anker erfassen.
            </Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Konto</th>
                    <th>Anker (Stichtag)</th>
                    <th style={{ textAlign: 'right' }}>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {salden.map((k) => (
                    <tr key={k.bankkonto_id ?? 'ohne'}>
                      <td>{k.name}</td>
                      <td className="muted">{k.stichtag ? date(k.stichtag) : '—'}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(k.saldo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Fällig (14 Tage)">
          {faellig.length === 0 ? (
            <Empty>Keine fälligen Zahlungen in den nächsten zwei Wochen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Posten</th>
                    <th>Partner</th>
                    <th>Fällig</th>
                    <th style={{ textAlign: 'right' }}>Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {faellig.map((f) => (
                    <tr key={`${f.quelle}-${f.ref}`}>
                      <td><Link href={f.link}>{f.label}</Link></td>
                      <td className="muted">{f.partner ?? '—'}</td>
                      <td className={new Date(f.faellig_am) < new Date() ? 'mono' : 'mono muted'}>
                        {new Date(f.faellig_am) < new Date() && <span className="led warn" style={{ marginRight: 6 }} />}
                        {date(f.faellig_am)}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(f.betrag_eur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Zahlungsregister (letzte 15)">
        {zahlungen.length === 0 ? (
          <Empty>Noch keine Zahlungen erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Datum</th>
                  <th>Richtung</th>
                  <th>Quelle</th>
                  <th>Partner</th>
                  <th>Konto</th>
                  <th>Zweck</th>
                  <th style={{ textAlign: 'right' }}>Betrag</th>
                </tr>
              </thead>
              <tbody>
                {zahlungen.map((z) => (
                  <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                    <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                    <td className="mono muted">{date(z.gezahlt_am)}</td>
                    <td>{z.richtung === 'ein' ? 'Eingang' : 'Ausgang'}</td>
                    <td className="muted">{z.quelle}</td>
                    <td className="muted">{z.partner ?? '—'}</td>
                    <td className="muted">{z.konto ?? '—'}</td>
                    <td className="muted">{z.verwendungszweck ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {z.richtung === 'ein' ? '+' : '−'}{money(z.betrag_eur)}
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
