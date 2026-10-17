import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Auswahl } from '@/components/auswahl'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { money, plural } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

async function belegverhaltenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.belegverhalten_setzen', { formData })
}

async function freigabenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.freigaben_setzen', { formData })
}

async function rechnungenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.rechnungen_setzen', { formData })
}

async function nummernkreisSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.nummernkreis_setzen', { formData })
}

async function probelaufLoeschen() {
  'use server'
  return serverAktion('verkauf.rechnung_probelauf_loeschen', { parameter: {} })
}

export default async function BelegePage() {
  await requireArea('einstellungen')
  const sales = await einstellung<{ lock_confirmed: boolean }>('sales')
  const purchase = await einstellung<{ lock_confirmed: boolean }>('purchase')
  const freigaben = await einstellung<{ einkauf_limit: number }>('freigaben')
  const rechnung = await einstellung<{
    automatisch: boolean
    modus?: 'aus' | 'test' | 'scharf'
    zahlungsziel_tage: number
    mahnfrist_tage: number
    kontenrahmen: string
    debitorenkonto: string
    erloeskonto_19: string
    erloeskonto_7: string
    erloeskonto_0: string
  }>('rechnung')
  // Der laufende Stand steht seit Migration 0026 in echten Sequenzen.
  const nummernkreise = await sql<{ code: string; prefix: string; next_number: number }[]>`
    select code, prefix, next_number from sequence_state()`
  // Probelauf (0117): der Modus aus der Datenbank (dieselbe Leseweise wie der Trigger) und die Testbelege.
  const [probelauf] = await sql<{ modus: 'aus' | 'test' | 'scharf'; testbelege: number; seit: string | null }[]>`
    select rechnung_modus() as modus,
           (select count(*)::int from kundenrechnungen where probe) as testbelege,
           (select min(created_at)::date::text from kundenrechnungen where probe) as seit`
  const modus = probelauf.modus

  const verkaufSperrt = sales.lock_confirmed ?? false
  const einkaufSperrt = purchase.lock_confirmed ?? false

  return (
    <>
      <EinstellungenKopf href="/einstellungen/belege" />

      <Card title="Belegverhalten">
        <ActionForm action={belegverhaltenSpeichern}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" name="sales_lock" defaultChecked={verkaufSperrt} />
              <span>Verkaufsaufträge beim Bestätigen sperren</span>
              <Zustand ton={verkaufSperrt ? 'ok' : 'off'}>{verkaufSperrt ? 'gesperrt' : 'offen'}</Zustand>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" name="purchase_lock" defaultChecked={einkaufSperrt} />
              <span>Bestellungen beim Bestätigen sperren</span>
              <Zustand ton={einkaufSperrt ? 'ok' : 'off'}>{einkaufSperrt ? 'gesperrt' : 'offen'}</Zustand>
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gesperrte Belege lassen sich nach dem Bestätigen nicht mehr ändern, nur stornieren. Die
          Leuchte zeigt den gespeicherten Stand; gilt ab der nächsten Bestätigung.
        </p>
      </Card>

      <Card title="Freigaben">
        <ActionForm action={freigabenSpeichern}>
          <div className="row">
            <label className="field" style={{ maxWidth: 280 }}>
              <span>Einkauf: Freigabe ab Bestellsumme (netto, €)</span>
              <input
                type="number"
                name="einkauf_limit"
                step="0.01"
                min="0"
                defaultValue={freigaben.einkauf_limit ?? ''}
                placeholder="leer = keine Freigabepflicht"
              />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
            <div className="shrink field">
              {freigaben.einkauf_limit != null ? (
                <Zustand ton="ok">aktiv ab {money(freigaben.einkauf_limit)}</Zustand>
              ) : (
                <Zustand ton="off">keine Freigabepflicht</Zustand>
              )}
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Ab dieser Summe lässt sich eine Bestellung erst nach Freigabe bestätigen — auf jedem Weg
          (Knopf, API, KI). Wer freigeben darf, regelt die Befugnis „Bestellungen freigeben" unter{' '}
          <Link href="/einstellungen/benutzer">Benutzer</Link>; Administratoren dürfen immer.
          Positionsänderungen lassen eine erteilte Freigabe erlöschen.
        </p>
      </Card>

      <Card title="Kundenrechnungen">
        <ActionForm action={rechnungenSpeichern}>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
            <label className="field">
              <span>Modus</span>
              <Auswahl name="modus" defaultValue={modus}>
                <option value="test">Probelauf — Testrechnungen PROBE-RE-… parallel zum Shop, zählen nirgends</option>
                <option value="scharf">Scharf — echte Rechnungen RE-… mit jeder gebuchten Lieferung</option>
                <option value="aus">Aus — Rechnung nur von Hand aus der Lieferung</option>
              </Auswahl>
            </label>
            <div className="shrink field">
              <Zustand ton={modus === 'scharf' ? 'ok' : modus === 'test' ? 'warn' : 'off'}>
                {modus === 'scharf' ? 'scharf' : modus === 'test' ? 'Probelauf' : 'aus'}
              </Zustand>
            </div>
          </div>
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            Im Probelauf entsteht mit jeder Lieferung eine <strong>Testrechnung</strong> (eigener Nummernkreis PROBE-RE-/PROBE-GU-,
            Banner im PDF) — nicht in DATEV, Fälligkeiten und Umsatz, aber mit Gutschriften bei Shop-Änderungen wie im
            Ernstfall. Scharf schalten geht erst, wenn der Probelauf gelöscht ist; vorher Nummernkreise RE-/GU- und
            Firmendaten prüfen und den Rechnungsausgang in sevDesk abschalten.
          </p>
          <div className="row">
            <label className="field">
              <span>Zahlungsziel (Tage, Firmenkunden)</span>
              <input type="number" name="zahlungsziel_tage" min="0" max="120" defaultValue={rechnung.zahlungsziel_tage ?? 14} />
            </label>
            <label className="field">
              <span>Mahnfrist (Tage)</span>
              <input type="number" name="mahnfrist_tage" min="0" max="60" defaultValue={rechnung.mahnfrist_tage ?? 7} />
            </label>
            <label className="field">
              <span>Kontenrahmen</span>
              <Auswahl name="kontenrahmen" defaultValue={rechnung.kontenrahmen ?? 'SKR03'}>
                <option value="SKR03">SKR03</option>
                <option value="SKR04">SKR04</option>
              </Auswahl>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Debitorenkonto (Sammel)</span>
              <input className="mono" name="debitorenkonto" defaultValue={rechnung.debitorenkonto ?? '10000'} />
            </label>
            <label className="field">
              <span>Erlöskonto 19 %</span>
              <input className="mono" name="erloeskonto_19" defaultValue={rechnung.erloeskonto_19 ?? '8400'} />
            </label>
            <label className="field">
              <span>Erlöskonto 7 %</span>
              <input className="mono" name="erloeskonto_7" defaultValue={rechnung.erloeskonto_7 ?? '8300'} />
            </label>
            <label className="field">
              <span>Erlöskonto 0 % (steuerfrei)</span>
              <input className="mono" name="erloeskonto_0" defaultValue={rechnung.erloeskonto_0 ?? '8120'} />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Shop-Aufträge sind beim Versand bezahlt (Zahlungsart aus Shopify), Firmenkunden bekommen die Rechnung mit
          Zahlungsziel. Die Konten füllen den DATEV-Buchungsstapel unter Verkauf → Rechnungen; die Pflichtangaben im
          Rechnungsfuß stehen unter <Link href="/einstellungen">Firmendaten</Link>.
        </p>
      </Card>

      <Card title="Rechnungs-Probelauf" tight>
        <div style={{ padding: 12 }}>
          <p className="small" style={{ margin: '0 0 8px' }}>
            {probelauf.testbelege > 0 ? (
              <>
                <strong>{plural(probelauf.testbelege, 'Testbeleg', 'Testbelege')}</strong>{probelauf.seit ? ` seit ${probelauf.seit}` : ''} in der Datenbank —{' '}
                <Link href="/verkauf/rechnungen?filter=probelauf">Vergleich mit dem Shop ansehen</Link>. Löschen entfernt alle
                Testbelege samt ihrer Zahlungen, rechnet die berechneten Mengen der Aufträge neu und setzt die Probe-Nummernkreise
                zurück; echte Belege bleiben.
              </>
            ) : (
              <>Kein Testbeleg in der Datenbank{modus === 'test' ? ' — der erste entsteht mit der nächsten gebuchten Lieferung' : ''}.</>
            )}
          </p>
          <ActionButton
            action={probelaufLoeschen}
            disabled={probelauf.testbelege === 0}
            confirm={`Alle ${probelauf.testbelege} Testbelege des Probelaufs unwiderruflich löschen? Echte Belege bleiben unberührt.`}
          >
            Probelauf löschen
          </ActionButton>
        </div>
      </Card>

      <Card title="Nummernkreise" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Beleg</th>
                <th>Präfix</th>
                <th className="num">Nächste Nummer</th>
              </tr>
            </thead>
            <tbody>
              {nummernkreise.map((n) => (
                <tr key={n.code}>
                  <td className="mono small">{n.code}</td>
                  <td className="mono">{n.prefix}</td>
                  <td className="num mono">{n.next_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <ActionForm action={nummernkreisSpeichern}>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field shrink">
                <span>Nummernkreis</span>
                <Auswahl name="code" defaultValue="kundenrechnung">
                  {nummernkreise.map((n) => (
                    <option key={n.code} value={n.code}>{n.code} ({n.prefix})</option>
                  ))}
                </Auswahl>
              </label>
              <label className="field shrink">
                <span>Nächste Nummer</span>
                <input type="number" name="naechste" min="1" required style={{ width: 120 }} placeholder="z. B. 7813" />
              </label>
              <label className="field shrink">
                <span>Präfix (optional)</span>
                <input name="prefix" className="mono" style={{ width: 100 }} placeholder="RE-" />
              </label>
              <div className="shrink field">
                <button type="submit">Setzen</button>
              </div>
            </div>
          </ActionForm>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Für die Umstellung: Kundenrechnungen und Gutschriften an die bisherige Nummerierung anschließen (lückenlos
            fortlaufend je Kreis).
          </p>
        </div>
      </Card>
    </>
  )
}
