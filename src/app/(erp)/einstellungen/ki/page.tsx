import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { KI_EBENEN, MODELL_KATALOG, modellAufloesen } from '@/modules/ki/modelle'
import { kiConfigured } from '@/modules/ki/agent'

export const dynamic = 'force-dynamic'

async function kiModelleSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.ki_modelle_setzen', { formData })
}

export default async function KiModellePage() {
  await requireArea('einstellungen')
  const modelle = await einstellung<Record<string, unknown>>('ki_modelle')
  const verbunden = kiConfigured()

  return (
    <>
      <EinstellungenKopf href="/einstellungen/ki" />

      <Card title="Modell je Ebene">
        <div style={{ marginBottom: 12 }}>
          <Zustand ton={verbunden ? 'ok' : 'off'}>
            {verbunden ? 'Anthropic verbunden' : 'nicht konfiguriert — ANTHROPIC_API_KEY fehlt, die KI ist aus'}
          </Zustand>
        </div>
        <ActionForm action={kiModelleSpeichern}>
          <div className="row">
            {KI_EBENEN.map((ebene) => (
              <label key={ebene.key} className="field">
                <span title={ebene.hinweis}>{ebene.label}</span>
                <select name={ebene.key} defaultValue={modellAufloesen(modelle, ebene.key)}>
                  {MODELL_KATALOG.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hinweis}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gilt ab der nächsten Anfrage. Faustregel: Opus für den Prozess-Entwurf, Sonnet für
          Auswertungen, Haiku für den Sprachmodus — so bleiben die Kosten im Rahmen, ohne Qualität
          dort zu verlieren, wo sie zählt.
        </p>
      </Card>
    </>
  )
}
