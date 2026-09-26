import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { FINANZ_FELDER } from '@/modules/einstellungen/finanz-parameter'

export const dynamic = 'force-dynamic'

async function finanzParameterSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.finanz_parameter_setzen', { formData })
}

export default async function FinanzenEinstellungenPage() {
  await requireArea('einstellungen')
  const werte = await einstellung<Record<string, number>>('finanzen')

  return (
    <>
      <EinstellungenKopf href="/einstellungen/finanzen" />

      <Card title="Prognose-Stellschrauben">
        <ActionForm action={finanzParameterSpeichern}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 12,
            }}
          >
            {FINANZ_FELDER.map((feld) => (
              <label className="field" key={feld.name}>
                <span>{feld.label}</span>
                <input
                  className="mono"
                  type="number"
                  name={feld.name}
                  step="any"
                  min={feld.min}
                  max={feld.max}
                  defaultValue={werte[feld.name] ?? ''}
                  required
                />
              </label>
            ))}
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Diese Werte steuern die Cashflow-Prognose unter <Link href="/finanzen">Finanzen</Link>: die
          Quoten rechnen variable Kosten vom Planumsatz, die Versätze verschieben Einzahlungen, das
          Band spannt Best/Worst um den Basisplan, der Puffer legt fest, ab wann die Prognose
          Fremdkapitalbedarf ausweist. Gilt sofort; nichts davon ist im Code festgelegt.
        </p>
      </Card>
    </>
  )
}
