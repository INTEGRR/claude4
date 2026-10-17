import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton } from '@/components/action-button'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { HANDARBEIT, type ProduktivgangStand, produktivgangBewerten } from '@/modules/einstellungen/produktivgang'
import { shopifyModus } from '@/modules/integrationen/shopify-modus'
import { gestoerteDienste } from '@/modules/integrationen/wache'
import { kiPfadBereit, kiRegionAufloesen } from '@/modules/ki/region'
import { plural } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Produktivgang (Entscheidungslog 2026-10-17): die Go-live-Checkliste, die
 * sich selbst prüft. Nur lesend — jede Zeile führt zu der Seite, auf der man
 * den Punkt erledigt. Ablauf und Stichtag: docs/go-live.md (API-Weg).
 */

async function pruefeDienste() {
  'use server'
  // Dienste-Wächter von Hand anstoßen — dieselbe Registry-Aktion wie auf /integrationen.
  return serverAktion('einstellungen.dienste_pruefen', { parameter: {} })
}

async function standLesen(): Promise<ProduktivgangStand> {
  const [firma, nummernkreise, [rechnung], modus, gestoert, kiRegion, [konten], [aufgaben]] = await Promise.all([
    einstellung<Record<string, string | undefined>>('company'),
    sql<{ code: string; next_number: number }[]>`select code, next_number from sequence_state()`,
    sql<{ modus: 'aus' | 'test' | 'scharf'; probe: number }[]>`
      select rechnung_modus() as modus, (select count(*)::int from kundenrechnungen where probe) as probe`,
    shopifyModus(sql),
    gestoerteDienste(sql),
    einstellung<Record<string, unknown>>('ki_region'),
    sql<{ ohne2fa: number; startkonto: boolean }[]>`
      select count(*) filter (where role = 'admin' and totp_aktiviert_at is null)::int as ohne2fa,
             bool_or(lower(email) = 'admin@example.com') as startkonto
      from users where active`,
    sql<{ offen: number }[]>`
      select count(*)::int as offen from aufgaben
      where einrichtung_schluessel is not null and status = 'offen'`,
  ])
  return {
    env: process.env,
    firma: firma ?? {},
    nummernkreise,
    rechnungModus: rechnung.modus,
    probeRechnungen: rechnung.probe,
    shopifyModus: modus,
    gestoerteDienste: gestoert,
    // einstellung() liefert {} ohne Zeile — entschieden ist erst eine gespeicherte Region (oder der Env-Notausgang).
    kiRegionGesetzt: Boolean((kiRegion as { region?: unknown }).region) || Boolean(process.env.KI_REGION),
    kiRegionBereit: kiPfadBereit(kiRegionAufloesen(kiRegion)),
    adminsOhne2fa: konten.ohne2fa,
    startkontoAktiv: Boolean(konten.startkonto),
    offeneEinrichtung: aufgaben.offen,
  }
}

export default async function ProduktivgangPage() {
  await requireArea('einstellungen')
  const punkte = produktivgangBewerten(await standLesen())
  const offen = punkte.filter((p) => p.ton === 'warn').length
  const gruppen = [...new Set(punkte.map((p) => p.gruppe))]

  return (
    <>
      <EinstellungenKopf
        href="/einstellungen/produktivgang"
        untertitel={
          offen === 0
            ? 'Alle automatischen Prüfungen sind grün — es bleibt die Handarbeit unten.'
            : `${plural(offen, 'Punkt ist', 'Punkte sind')} vor dem Stichtag noch offen.`
        }
        actions={<ActionButton action={pruefeDienste}>Dienste jetzt prüfen</ActionButton>}
      />

      {gruppen.map((gruppe) => (
        <Card key={gruppe} title={gruppe} tight>
          <TableWrap>
            <table>
              <tbody>
                {punkte
                  .filter((p) => p.gruppe === gruppe)
                  .map((p) => (
                    <tr key={p.schluessel}>
                      <td style={{ width: '32%' }}>
                        <Link href={p.link}>{p.titel}</Link>
                      </td>
                      <td>
                        <Zustand ton={p.ton}>{p.text}</Zustand>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ))}

      <Card title="Von Hand prüfen">
        <p className="small muted" style={{ marginTop: 0 }}>
          Diese Punkte sieht KRNL nicht. Abhaken in der Go-live-Checkliste (docs/go-live.md).
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {HANDARBEIT.map((h) => (
            <li key={h.titel}>
              <strong>{h.titel}:</strong> {h.text}
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}
