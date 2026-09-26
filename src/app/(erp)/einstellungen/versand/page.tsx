import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { DRUCKFORMATE } from '@/modules/einstellungen/finanz-parameter'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/** Ein Agent gilt als lebendig, wenn er in dieser Zeit abgeholt hat (er fragt alle paar Sekunden). */
const AGENT_LEBT_MINUTEN = 15

async function versandVorgabenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.versand_vorgaben_setzen', { formData })
}

async function druckbrueckeSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.druckbruecke_setzen', { formData })
}

export default async function VersandPage() {
  await requireArea('einstellungen')
  const dhl = await einstellung<{ print_format: string }>('dhl')
  const druck = await einstellung<{ modus: string; token: string; agenten: Record<string, string> }>('druckbruecke')
  const druckModus = druck.modus === 'bruecke' ? 'bruecke' : 'pdf'
  const agenten = Object.entries(druck.agenten ?? {}).sort((a, b) => (a[1] < b[1] ? 1 : -1))
  const jetzt = Date.now()

  return (
    <>
      <EinstellungenKopf href="/einstellungen/versand" />

      <Card title="Labelformat (DHL)">
        <ActionForm action={versandVorgabenSpeichern}>
          <div className="row">
            <label className="field" style={{ maxWidth: 320 }}>
              <span>Druckformat der Labels</span>
              <select name="print_format" defaultValue={dhl.print_format ?? '910-300-700'}>
                {DRUCKFORMATE.map((f) => (
                  <option key={f.wert} value={f.wert}>{f.label}</option>
                ))}
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gilt ab dem nächsten Label. Welches DHL-Produkt eine Sendung bekommt, entscheiden die{' '}
          <Link href="/einstellungen/versandregeln">Versandregeln</Link> (ohne Treffer: nach Zielzone).
          Zugangsdaten sind Umgebungsvariablen — ihren Stand zeigt{' '}
          <Link href="/einstellungen/anbindungen">Schnittstellen</Link>.
        </p>
      </Card>

      <Card title="Druckweg (Labels und Fertigungszettel)">
        <ActionForm action={druckbrueckeSpeichern}>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
              <input type="radio" name="modus" value="pdf" defaultChecked={druckModus === 'pdf'} />
              <span>
                <strong>PDF im Browser</strong> — Labels und Zettel öffnen als Tab, gedruckt wird über
                den Browser-Dialog (zum Testen, ohne Einrichtung).
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="radio" name="modus" value="bruecke" defaultChecked={druckModus === 'bruecke'} />
              <span>
                <strong>Druckbrücke</strong> — stiller Direktdruck über Agenten an den Arbeitsplatz-PCs
                (Labeldrucker am Packtisch, A4 in der Werkstatt).
              </span>
            </label>
          </fieldset>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Agent-Token (leer = behalten bzw. beim Umstellen erzeugen)</span>
              <input
                type="text"
                name="token"
                className="mono"
                defaultValue={druck.token ?? ''}
                placeholder="wird beim Aktivieren der Brücke erzeugt"
                autoComplete="off"
              />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gilt sofort. Für die Brücke auf jedem Druck-PC einen Agenten mit diesem Token starten
          (<span className="mono">scripts/druck-agent.ts</span>, Anleitung in docs/module/versand.md).
        </p>
      </Card>

      <Card title={`Druck-Agenten (${agenten.length})`} tight>
        {agenten.length === 0 ? (
          <Empty>
            {druckModus === 'bruecke'
              ? 'Noch kein Agent hat sich gemeldet.'
              : 'PDF-Modus — Agenten werden erst mit der Druckbrücke gebraucht.'}
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Zustand</th>
                  <th>Zuletzt gemeldet</th>
                </tr>
              </thead>
              <tbody>
                {agenten.map(([name, zeit]) => {
                  const lebt = jetzt - new Date(zeit).getTime() < AGENT_LEBT_MINUTEN * 60_000
                  return (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td>
                        <Zustand ton={lebt ? 'ok' : 'warn'}>{lebt ? 'aktiv' : 'still'}</Zustand>
                      </td>
                      <td className="small muted mono">{dateTime(zeit)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
