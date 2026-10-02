import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { sql } from '@/db/client'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { KI_EBENEN, MODELL_KATALOG, modellAufloesen } from '@/modules/ki/modelle'
import { kiConfigured } from '@/modules/ki/agent'
import { kiFake, uebersetzungMoeglich } from '@/modules/ki/uebersetzen'
import { einkaufKiStandLesen, verbrauchImMonat, verbrauchJeEbene } from '@/modules/ki/einkauf-ki'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

async function kiModelleSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.ki_modelle_setzen', { formData })
}

async function kiEinkaufSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.ki_einkauf_setzen', { formData })
}

const tausend = (n: number) => Math.round(n).toLocaleString('de-DE')

export default async function KiModellePage() {
  await requireArea('einstellungen')
  const modelle = await einstellung<Record<string, unknown>>('ki_modelle')
  const einkauf = einkaufKiStandLesen(await einstellung<Record<string, unknown>>('ki_einkauf'))
  const verbunden = kiConfigured()
  // Der Agent läuft mit Schlüssel oder mit der Attrappe (KI_FAKE=1).
  const agentBereit = uebersetzungMoeglich()
  const [monat, jeEbene] = await Promise.all([verbrauchImMonat(sql, 'einkauf'), verbrauchJeEbene(sql)])
  const ebenenName = new Map<string, string>(KI_EBENEN.map((e) => [e.key, e.label]))

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
                <Auswahl name={ebene.key} defaultValue={modellAufloesen(modelle, ebene.key)}>
                  {MODELL_KATALOG.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hinweis}
                    </option>
                  ))}
                </Auswahl>
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

      <Card title="Einkaufs-Agent (KI-Ebene „Einkauf“)">
        <div style={{ marginBottom: 12 }}>
          <Zustand ton={einkauf.aktiv && agentBereit ? 'ok' : einkauf.aktiv ? 'warn' : 'off'}>
            {einkauf.aktiv
              ? agentBereit
                ? `an — jede eingehende Lieferanten-Mail wird gesichtet${kiFake() ? ' (KI_FAKE: Attrappe statt Claude)' : ''}`
                : 'an, aber ohne ANTHROPIC_API_KEY — der Agent überspringt'
              : 'aus'}
          </Zustand>
        </div>
        <ActionForm action={kiEinkaufSpeichern}>
          <div className="row">
            <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" name="aktiv" defaultChecked={einkauf.aktiv} />
              <span>Agent einschalten</span>
            </label>
            <label className="field">
              <span>Obergrenze Token je Monat (leer = keine)</span>
              <input
                type="text"
                inputMode="numeric"
                name="monats_tokens"
                defaultValue={einkauf.monats_tokens ? tausend(einkauf.monats_tokens) : ''}
                placeholder="z. B. 5.000.000"
              />
            </label>
            <div className="field shrink">
              <button className="primary" type="submit">
                Speichern
              </button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Der Agent legt nur <strong>Vorschläge</strong> (Zuordnung, Angebot erfassen, Wiedervorlage,
          Entscheidungsvorlage) und <strong>Mail-Entwürfe</strong> an — gesendet wird erst nach Freigabe, ausgeführt
          erst mit „Annehmen". Er liest PDFs und Bilder (Excel noch nicht). Diesen Monat:{' '}
          {monat.aufrufe} Läufe, {tausend(monat.summe)} Token
          {einkauf.monats_tokens ? ` von ${tausend(einkauf.monats_tokens)}` : ''}.
        </p>
      </Card>

      <Card title="Verbrauch diesen Monat" tight>
        {jeEbene.length === 0 ? (
          <p className="small muted" style={{ margin: 12 }}>
            Noch keine KI-Aufrufe in diesem Monat protokolliert.
          </p>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Ebene</th>
                  <th>Modell</th>
                  <th className="num">Aufrufe</th>
                  <th className="num">Eingabe</th>
                  <th className="num">Cache gelesen</th>
                  <th className="num">Cache geschrieben</th>
                  <th className="num">Ausgabe</th>
                </tr>
              </thead>
              <tbody>
                {jeEbene.map((v) => (
                  <tr key={`${v.ebene}:${v.modell}`}>
                    <td>{ebenenName.get(v.ebene) ?? v.ebene}</td>
                    <td className="mono small">{v.modell}</td>
                    <td className="num">{v.aufrufe}</td>
                    <td className="num">{tausend(v.input)}</td>
                    <td className="num">{tausend(v.cache_lesen)}</td>
                    <td className="num">{tausend(v.cache_schreiben)}</td>
                    <td className="num">{tausend(v.output)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="small muted" style={{ margin: 0, padding: '8px 12px' }}>
          Token je Ebene und Modell aus dem Verbrauchsprotokoll (ki_verbrauch). Die Kosten stehen in der
          Abrechnung von Anthropic — gelesene Cache-Token kosten dort nur einen Bruchteil.
        </p>
      </Card>
    </>
  )
}
