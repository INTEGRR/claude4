import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ROLE_LABELS, type Role } from '@/modules/auth/permissions'
import { FENSTER_MINUTEN, MAX_JE_ABSENDER, MAX_JE_KONTO } from '@/modules/auth/drossel'
import {
  GERAET_TAGE,
  PFLICHT_LABELS,
  SITZUNG_TAGE,
  WARTEND_MINUTEN,
  type ZweiFaktorPflicht,
  pflichtGilt,
  sicherheitsEinstellung,
} from '@/modules/auth/zweifaktor'
import { ActionForm } from '@/components/action-button'
import { Card, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'

export const dynamic = 'force-dynamic'

async function sicherheitSpeichern(formData: FormData) {
  'use server'
  // Registry-Aktion, damit das Lockern der Pflicht auditiert ist.
  return serverAktion('einstellungen.sicherheit_setzen', { formData })
}

const PFLICHT_TEXT: Record<ZweiFaktorPflicht, string> = {
  alle: 'Jeder Benutzer richtet den zweiten Faktor beim nächsten Seitenaufruf ein — auch Lager- und Werkstattkonten.',
  admins: 'Administratoren müssen, alle anderen können freiwillig (Konto & Sicherheit).',
  freiwillig: 'Niemand wird zur Einrichtung geschickt; wer will, richtet ihn im eigenen Konto ein.',
}

export default async function SicherheitPage() {
  await requireArea('einstellungen')
  const { zwei_faktor } = await sicherheitsEinstellung(sql)
  const konten = await sql<{ id: string; name: string; role: Role; totp_aktiv: boolean }[]>`
    select id, name, role, totp_aktiviert_at is not null as totp_aktiv
    from users where active order by name`
  const ohne = konten.filter((k) => !k.totp_aktiv)
  const pflichtigOhne = ohne.filter((k) => pflichtGilt(k.role, zwei_faktor))

  return (
    <>
      <EinstellungenKopf href="/einstellungen/sicherheit" />

      <Card title="Zweiter Faktor">
        <div style={{ marginBottom: 12 }}>
          <Zustand ton={ohne.length === 0 ? 'ok' : 'warn'}>
            {konten.length - ohne.length} von {konten.length} aktiven Konten haben die Authenticator-App eingerichtet
          </Zustand>
        </div>
        <ActionForm action={sicherheitSpeichern}>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend className="mono-label" style={{ marginBottom: 8 }}>Pflicht</legend>
            {(Object.keys(PFLICHT_LABELS) as ZweiFaktorPflicht[]).map((wert) => (
              <label key={wert} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                <input type="radio" name="zwei_faktor" value={wert} defaultChecked={zwei_faktor === wert} />
                <span>
                  <strong>{PFLICHT_LABELS[wert]}</strong> — {PFLICHT_TEXT[wert]}
                </span>
              </label>
            ))}
          </fieldset>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Gilt sofort. Telefon verloren: unter <Link href="/einstellungen/benutzer">Benutzer</Link>{' '}
          „2FA zurücksetzen" — der nächste Login richtet neu ein. Eigene Backup-Codes und vertraute
          Geräte verwaltet jeder unter <Link href="/konto">Konto &amp; Sicherheit</Link>.
        </p>
      </Card>

      {ohne.length > 0 && (
        <Card title={`Konten ohne zweiten Faktor (${ohne.length})`}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ohne.map((k) => (
              <li key={k.id} className="small">
                {k.name} <span className="muted">· {ROLE_LABELS[k.role]}</span>
                {pflichtGilt(k.role, zwei_faktor) && (
                  <span className="muted"> · wird beim nächsten Seitenaufruf zur Einrichtung geschickt</span>
                )}
              </li>
            ))}
          </ul>
          {pflichtigOhne.length === 0 && (
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Für diese Konten gilt nach der aktuellen Einstellung keine Pflicht.
            </p>
          )}
        </Card>
      )}

      <Card title="Regeln der Anmeldung">
        <dl className="small" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px' }}>
          <dt className="muted">Drossel</dt>
          <dd style={{ margin: 0 }}>
            {MAX_JE_KONTO} Fehlversuche je Konto oder {MAX_JE_ABSENDER} je Absender in {FENSTER_MINUTEN} Minuten
            sperren die Anmeldung — falsche Passwörter und falsche Codes zählen gemeinsam.
          </dd>
          <dt className="muted">Sitzung</dt>
          <dd style={{ margin: 0 }}>
            {SITZUNG_TAGE} Tage; nach dem Passwort wartet sie {WARTEND_MINUTEN} Minuten auf den Code.
          </dd>
          <dt className="muted">Vertraute Geräte</dt>
          <dd style={{ margin: 0 }}>{GERAET_TAGE} Tage ohne Code, jederzeit widerrufbar.</dd>
          <dt className="muted">Meldungen</dt>
          <dd style={{ margin: 0 }}>
            Anmeldungen, Fehlversuche und Sperren gehen als Telegram-Nachricht hinaus —{' '}
            <Link href="/einstellungen/benachrichtigungen">Benachrichtigungen</Link>.
          </dd>
        </dl>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Diese Werte sind im Code festgelegt und hier nur zur Übersicht aufgeführt.
        </p>
      </Card>
    </>
  )
}
