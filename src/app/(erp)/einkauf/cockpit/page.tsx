import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canAccess, canWrite } from '@/modules/auth/permissions'
import { ActionButton } from '@/components/action-button'
import { Card, Empty, PageHeader } from '@/components/ui'
import { COCKPIT_KATEGORIEN, type CockpitEintrag, cockpitGruppieren, cockpitLaden } from '@/modules/einkauf/cockpit'
import { date } from '@/modules/shared/format'
import { pflichtdokumenteNachfragen } from '../sendungen/actions'

export const dynamic = 'force-dynamic'

const PFAD = '/einkauf/cockpit'

/** Was das Datum eines Eintrags bedeutet. */
function datumWort(kategorie: CockpitEintrag['kategorie']): string {
  if (kategorie === 'sendungen') return 'ETA'
  if (['wartet_uns', 'wartet_lieferant', 'unzugeordnet', 'rechnungen', 'muster'].includes(kategorie)) return 'seit'
  return 'fällig'
}

/**
 * Einkaufs-Cockpit (0108): was heute ansteht — je Einkäufer (Meine/Alle):
 * überfällig, heute fällig, überfällige ETA, fehlende Dokumente und
 * Rechnungen, fällige Raten (mit Finanzrecht), wartet auf uns / auf den
 * Lieferanten, nicht zugeordnete Mails, laufende Sendungen und Muster,
 * Werkzeuge am Lebensende. Jeder Eintrag führt zu seinem Beleg; dieselben
 * Daten gehen morgens als Zusammenfassung in den Telegram-Kanal.
 */
export default async function CockpitPage({ searchParams }: { searchParams: Promise<{ alle?: string }> }) {
  const user = await requireArea('einkauf')
  const darf = canWrite(user.rollen, 'einkauf', user.befugnisse)
  const finanzen = canAccess(user.rollen, 'finanzen', user.befugnisse)
  const { alle } = await searchParams
  const nurMeine = alle !== '1'

  const eintraege = await cockpitLaden(sql, { zustaendigId: nurMeine ? user.id : null, finanzen })
  const gruppen = cockpitGruppieren(eintraege)
  const namen = new Map(
    (await sql<{ id: string; name: string }[]>`select id, name from users`).map((u) => [u.id, u.name]),
  )
  const heute = new Date().toISOString().slice(0, 10)
  const handeln = gruppen.filter((g) => COCKPIT_KATEGORIEN[g.kategorie].digest)
  const lage = gruppen.filter((g) => !COCKPIT_KATEGORIEN[g.kategorie].digest)

  const zeile = (e: CockpitEintrag) => {
    const ueberfaellig = e.faellig_am !== null && e.faellig_am < heute && !['sendungen', 'muster', 'wartet_lieferant', 'wartet_uns', 'unzugeordnet'].includes(e.kategorie)
    return (
      <li key={`${e.kategorie}:${e.modell}:${e.record_id}:${e.titel}`} className="dok-zeile">
        <div className="dok-text">
          <Link href={e.link} className={ueberfaellig ? 'dok-name wv-ueberfaellig' : 'dok-name'}>
            {e.titel}
          </Link>
          <div className="muted small">
            {e.detail ?? ''}
            {e.faellig_am ? `${e.detail ? ' · ' : ''}${datumWort(e.kategorie)} ${date(e.faellig_am)}` : ''}
            {!nurMeine && e.zustaendig_id ? ` · ${namen.get(e.zustaendig_id) ?? ''}` : ''}
          </div>
        </div>
      </li>
    )
  }

  /** Je Beleg mit fehlenden Dokumenten ein Knopf „nachfragen". */
  const nachfragen = (liste: CockpitEintrag[]) => {
    const belege = [...new Map(liste.map((e) => [`${e.modell}:${e.record_id}`, e])).values()].filter(
      (e) => e.modell === 'purchase_order' || e.modell === 'eingangs_sendung',
    )
    if (!darf || belege.length === 0) return null
    return (
      <div className="actions" style={{ padding: '8px 12px' }}>
        {belege.slice(0, 12).map((e) => (
          <ActionButton
            key={`${e.modell}:${e.record_id}`}
            className="small"
            action={pflichtdokumenteNachfragen.bind(null, e.modell as 'purchase_order' | 'eingangs_sendung', e.record_id)}
          >
            {e.titel.split(':')[0]} nachfragen
          </ActionButton>
        ))}
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="Einkaufs-Cockpit"
        subtitle={nurMeine ? `Was bei ${user.name} ansteht` : 'Was im Einkauf ansteht — alle Einkäufer'}
        actions={
          <>
            <Link className="btn" href="/einkauf/wiedervorlagen">
              Wiedervorlagen
            </Link>
            <Link className="btn" href="/einkauf/sendungen">
              Sendungen
            </Link>
          </>
        }
      />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          <Link className="btn small" href={PFAD} aria-current={nurMeine ? 'page' : undefined}>
            <span className={nurMeine ? 'led on' : 'led off'} /> Meine
          </Link>
          <Link className="btn small" href={`${PFAD}?alle=1`} aria-current={!nurMeine ? 'page' : undefined}>
            <span className={!nurMeine ? 'led on' : 'led off'} /> Alle
          </Link>
          {gruppen.map((g) => (
            <a key={g.kategorie} className="btn small" href={`#${g.kategorie}`}>
              {COCKPIT_KATEGORIEN[g.kategorie].label} <strong>{g.eintraege.length}</strong>
            </a>
          ))}
        </div>
        {gruppen.length === 0 && <Empty>Nichts offen — der Einkauf ist auf Stand.</Empty>}
      </Card>

      {handeln.map((g) => (
        <section key={g.kategorie} id={g.kategorie}>
          <Card title={`${COCKPIT_KATEGORIEN[g.kategorie].label} (${g.eintraege.length})`} tight>
            <p className="small muted" style={{ margin: 0, padding: '8px 12px 0' }}>
              {COCKPIT_KATEGORIEN[g.kategorie].hinweis}
            </p>
            <ul className="dok-liste">{g.eintraege.slice(0, 50).map(zeile)}</ul>
            {g.eintraege.length > 50 && (
              <p className="small muted" style={{ margin: 0, padding: '0 12px 8px' }}>
                … und {g.eintraege.length - 50} weitere
              </p>
            )}
            {g.kategorie === 'dokumente' && nachfragen(g.eintraege)}
          </Card>
        </section>
      ))}

      {lage.map((g) => (
        <section key={g.kategorie} id={g.kategorie}>
          <Card title={`${COCKPIT_KATEGORIEN[g.kategorie].label} (${g.eintraege.length})`} tight>
            <ul className="dok-liste">{g.eintraege.slice(0, 50).map(zeile)}</ul>
          </Card>
        </section>
      ))}

      <p className="small muted">
        Morgens geht dieselbe Übersicht gegliedert nach Einkäufer in den Telegram-Kanal (Einstellungen → Benachrichtigungen).
        {!finanzen && ' Fällige Raten sieht, wer den Finanzbereich sehen darf.'}
      </p>
    </>
  )
}
