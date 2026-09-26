import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'

export const dynamic = 'force-dynamic'

async function belegverhaltenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.belegverhalten_setzen', { formData })
}

async function freigabenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.freigaben_setzen', { formData })
}

export default async function BelegePage() {
  await requireArea('einstellungen')
  const sales = await einstellung<{ lock_confirmed: boolean }>('sales')
  const purchase = await einstellung<{ lock_confirmed: boolean }>('purchase')
  const freigaben = await einstellung<{ einkauf_limit: number }>('freigaben')
  // Der laufende Stand steht seit Migration 0026 in echten Sequenzen.
  const nummernkreise = await sql<{ code: string; prefix: string; next_number: number }[]>`
    select code, prefix, next_number from sequence_state()`

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
                <Zustand ton="ok">aktiv ab {Number(freigaben.einkauf_limit).toFixed(2)} €</Zustand>
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
      </Card>
    </>
  )
}
