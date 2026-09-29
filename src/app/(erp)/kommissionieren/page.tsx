import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { einstellung } from '@/modules/einstellungen/lesen'
import { Card, Empty, PageHeader, Zustand } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { naechsteFuer, sammelVorrat, type VorratZeile } from '@/modules/versand/kommissionieren'
import { StartenKnopf } from './starten-knopf'

export const dynamic = 'force-dynamic'

/**
 * Arbeitsvorrat des Kommissionierens (0091), fürs Handy zuerst gebaut:
 * versandbereite Lieferungen, Priorität und ältestes Datum zuerst. „Nächste
 * Bestellung" beansprucht die nächste freie (oder die eigene angefangene)
 * und öffnet den Sammel-Screen. Wer lieber mit Papier sammelt, druckt die
 * Packzettel im Versand und geht damit direkt zum Packtisch.
 */
export default async function KommissionierenPage() {
  const user = await requireArea('versand')
  const vorrat = await sammelVorrat()
  const [{ aktiv }] = await sql<{ aktiv: boolean }[]>`
    select prozessschritt_aktiv('shopify_bestellung_versand', 'kommissionieren') as aktiv`
  const { manuell_bestaetigen: manuell } = await einstellung<{ manuell_bestaetigen: boolean }>(
    'kommissionieren',
  )
  const naechste = naechsteFuer(vorrat, user.name)
  const offen = vorrat.filter((z) => !z.kommissioniertAm)
  const gesammelt = vorrat.filter((z) => z.kommissioniertAm)

  return (
    <>
      <PageHeader
        title="Kommissionieren"
        subtitle="Bestellung für Bestellung die Ware sammeln — am Handy scannen oder mit dem Packzettel, danach zum Packtisch"
        actions={
          <>
            {/* Die Betriebsart ist ein Zustand — sichtbar, wo gesammelt wird. */}
            <Link href="/einstellungen/versand" title="Einstellungen → Versand & Druck">
              <Zustand ton={manuell ? 'warn' : 'ok'}>
                {manuell ? 'ohne Scan erlaubt' : 'Scan-Pflicht'}
              </Zustand>
            </Link>
            <Link className="btn" href="/packtisch">
              Packtisch
            </Link>
          </>
        }
      />

      {!aktiv && (
        <div className="notice">
          Der Schritt „Kommissionieren" ist im Versandprozess abgeschaltet — Lieferungen gehen
          direkt zum Packtisch. Sammeln geht trotzdem; einschalten unter{' '}
          <Link href="/prozesse/shopify_bestellung_versand">Prozesse → Versand</Link>.
        </div>
      )}

      <div className="kommi-start">
        {naechste ? (
          <StartenKnopf className="primary big" pickingId={naechste.pickingId}>
            {naechste.sammler === user.name ? 'Weiter sammeln' : 'Nächste Bestellung'}:{' '}
            <span className="mono">{naechste.number}</span>
          </StartenKnopf>
        ) : (
          <span className="muted">
            {offen.length > 0
              ? 'Alle offenen Bestellungen werden gerade von anderen gesammelt.'
              : 'Nichts zu sammeln — alles Versandbereite ist kommissioniert.'}
          </span>
        )}
      </div>

      <Card title={`Zu sammeln (${offen.length})`} tight>
        {offen.length === 0 ? (
          <Empty>Keine versandbereite Lieferung offen.</Empty>
        ) : (
          <ul className="kommi-liste">
            {offen.map((z) => (
              <VorratEintrag key={z.pickingId} z={z} ich={user.name} />
            ))}
          </ul>
        )}
      </Card>

      {gesammelt.length > 0 && (
        <Card title={`Gesammelt — wartet am Packtisch (${gesammelt.length})`} tight>
          <ul className="kommi-liste">
            {gesammelt.map((z) => (
              <VorratEintrag key={z.pickingId} z={z} ich={user.name} />
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

function VorratEintrag({ z, ich }: { z: VorratZeile; ich: string }) {
  const fremd = z.sammler && z.sammler !== ich
  return (
    <li className="kommi-eintrag">
      <div className="kommi-eintrag-text">
        <div>
          <Link className="mono" href={`/kommissionieren/${z.pickingId}`}>
            {z.number}
          </Link>{' '}
          <span className="mono small muted">{z.shopify ?? z.auftrag ?? ''}</span>
        </div>
        <div className="small">{z.kunde ?? '—'}</div>
        <div className="actions" style={{ gap: 8, marginTop: 4 }}>
          <span className="mono-label">
            {z.positionen} Artikel · {qty(z.stueck)} Stück
          </span>
          {z.priority && <Zustand ton="warn">Priorität</Zustand>}
          {z.sammler && <Zustand ton="on">sammelt: {z.sammler}</Zustand>}
          {!z.kommissioniertAm && z.gesammeltStueck > 0 && (
            <Zustand ton="warn">
              teilweise {qty(z.gesammeltStueck)}/{qty(z.stueck)}
            </Zustand>
          )}
          {z.kommissioniertAm && (
            <Zustand ton="ok">
              kommissioniert {z.kommissioniertVon ? `von ${z.kommissioniertVon} ` : ''}
              {dateTime(z.kommissioniertAm)}
            </Zustand>
          )}
          {z.packzettelGedrucktAm && <Zustand ton="off">Zettel gedruckt</Zustand>}
        </div>
      </div>
      {!z.kommissioniertAm && !fremd && (
        <div className="kommi-eintrag-knopf">
          <StartenKnopf className="small" pickingId={z.pickingId}>
            {z.sammler === ich ? 'Weiter' : 'Sammeln'}
          </StartenKnopf>
        </div>
      )}
    </li>
  )
}
