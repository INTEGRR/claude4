import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { telegramConfigured } from '@/modules/integrationen/telegram'
import {
  SCHALTER_LABELS,
  letzteBenachrichtigungen,
  schalter as benachrichtigungsSchalter,
} from '@/modules/integrationen/benachrichtigungen'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

async function benachrichtigungenSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.benachrichtigungen_setzen', { formData })
}

async function telegramTest() {
  'use server'
  return serverAktion('einstellungen.telegram_test', { parameter: {} })
}

async function telegramChats() {
  'use server'
  return serverAktion('einstellungen.telegram_chats', { parameter: {} })
}

const STATUS_TON = { gesendet: 'ok', offen: 'warn', fehlgeschlagen: 'on', uebersprungen: 'off' } as const

export default async function BenachrichtigungenPage() {
  await requireArea('einstellungen')
  const telegram = telegramConfigured()
  const schalter = await benachrichtigungsSchalter(sql)
  const meldungen = await letzteBenachrichtigungen(sql, 12)

  return (
    <>
      <EinstellungenKopf href="/einstellungen/benachrichtigungen" />

      <Card
        title="Telegram"
        actions={
          <>
            <ActionButton className="small" action={telegramTest} disabled={!telegram}>
              Testnachricht senden
            </ActionButton>
            <ActionButton className="small" action={telegramChats}>
              Chat-IDs ermitteln
            </ActionButton>
          </>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Zustand ton={telegram ? 'ok' : 'off'}>
            {telegram ? 'verbunden' : 'nicht konfiguriert — TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID fehlen'}
          </Zustand>
        </div>
        <ActionForm action={benachrichtigungenSpeichern}>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend className="mono-label" style={{ marginBottom: 8 }}>Was gemeldet wird</legend>
            {(Object.keys(SCHALTER_LABELS) as (keyof typeof SCHALTER_LABELS)[]).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" name={k} defaultChecked={schalter[k]} />
                <span className="small">{SCHALTER_LABELS[k]}</span>
              </label>
            ))}
          </fieldset>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Einrichten: Bot beim @BotFather anlegen, Token als <span className="mono">TELEGRAM_BOT_TOKEN</span>{' '}
          setzen, dem Bot einmal schreiben (oder in die Gruppe holen), dann „Chat-IDs ermitteln" und die
          ID als <span className="mono">TELEGRAM_CHAT_ID</span> setzen. Gesendet wird jede Minute vom
          Cron „jobs", Anmeldungen zusätzlich sofort; Fehlversuche werden je Konto und Viertelstunde
          gebündelt. Die Schalter gelten beim Senden, auch für schon eingereihte Meldungen.
        </p>
      </Card>

      {meldungen.length > 0 && (
        <Card title="Letzte Meldungen" tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Art</th>
                  <th>Status</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {meldungen.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap small muted mono">{dateTime(m.erstellt_at)}</td>
                    <td className="small">{m.art}</td>
                    <td>
                      <Zustand ton={STATUS_TON[m.status as keyof typeof STATUS_TON] ?? 'off'}>{m.status}</Zustand>
                      {m.fehler && <div className="small muted">{m.fehler}</div>}
                    </td>
                    <td className="small" style={{ whiteSpace: 'pre-line' }}>
                      {m.text.replace(/<[^>]+>/g, '').slice(0, 160)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </>
  )
}
