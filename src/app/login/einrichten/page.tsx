import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { nachAnfrageVersenden } from '@/modules/integrationen/benachrichtigungen-versand'
import { einrichtungAbschliessen, einrichtungKontext, logout } from '@/modules/auth'
import { geheimnisFormatieren, otpauthUrl } from '@/modules/auth/totp'
import { qrcodeSvg } from '@/modules/shared/barcode'
import { sql } from '@/db/client'
import { LoginRahmen } from '../rahmen'

/**
 * Einrichtung des zweiten Faktors: QR-Code scannen (oder Geheimnis
 * abtippen), ersten Code bestätigen. Erreichbar mit wartender Sitzung
 * (frischer Login unter Pflicht) und mit voller Altsitzung (Pflicht-
 * Nachzügler, vom Layout-Tor geschickt) — deshalb außerhalb der
 * (erp)-Gruppe, sonst Redirect-Kreis. Rahmen-Aktionen wie login:signIn.
 */

export const dynamic = 'force-dynamic'

async function einrichtungBestaetigen(formData: FormData) {
  'use server'
  // Telegram-Meldungen (Anmeldung, Fehlversuch) sofort nach der Antwort
  // senden — die Outbox bleibt die Wahrheit, der Cron holt den Rest.
  after(nachAnfrageVersenden)
  const ergebnis = await einrichtungAbschliessen(String(formData.get('code') ?? ''))
  if (ergebnis === 'ok') redirect('/konto?neu=1')
  if (ergebnis === 'keine_sitzung') redirect('/login?fehler=abgelaufen')
  if (ergebnis === 'nicht_eingerichtet') redirect('/login/code')
  redirect(`/login/einrichten?fehler=${ergebnis}`)
}

async function abbrechen() {
  'use server'
  await logout()
  redirect('/login')
}

export default async function EinrichtenSeite({
  searchParams,
}: {
  searchParams: Promise<{ fehler?: string }>
}) {
  const kontext = await einrichtungKontext()
  if (!kontext) redirect('/login')
  if (kontext.art === 'code') redirect('/login/code')
  if (kontext.art === 'fertig') redirect('/konto')
  const { fehler } = await searchParams

  const [firma] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  const aussteller = `KRNL ${firma?.name ?? ''}`.trim()
  const url = otpauthUrl(kontext.email, aussteller, kontext.secret)

  return (
    <LoginRahmen
      titel="Zweiten Faktor einrichten"
      status={`Angemeldet als ${kontext.name} — Einrichtung nötig`}
      breit
    >
      {fehler === 'gesperrt' ? (
        <div className="notice danger">
          Zu viele Fehlversuche — die Anmeldung ist für dieses Konto 15 Minuten gesperrt.
        </div>
      ) : fehler ? (
        <div className="notice danger">
          Der Code passt nicht. Stimmt die Uhrzeit des Telefons? Bitte den aktuellen Code eingeben.
        </div>
      ) : null}
      <p className="small muted" style={{ marginTop: 0 }}>
        Jede Anmeldung braucht ab jetzt zusätzlich einen Code aus einer Authenticator-App
        (Google Authenticator, Authy, 1Password, Bitwarden …). Der Code wechselt alle 30 Sekunden
        und funktioniert ohne Netz.
      </p>
      <ol className="small" style={{ paddingLeft: 18, margin: '0 0 12px' }}>
        <li>App öffnen und den QR-Code scannen — oder das Geheimnis von Hand eingeben.</li>
        <li>Den angezeigten Code unten eintragen.</li>
        <li>Danach erscheinen zehn Backup-Codes für den Notfall — bitte sicher ablegen.</li>
      </ol>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div
          style={{ background: '#fff', padding: 8, borderRadius: 6, lineHeight: 0 }}
          dangerouslySetInnerHTML={{ __html: qrcodeSvg(url, { scale: 4 }) }}
        />
        <div className="small" style={{ flex: 1, minWidth: 200 }}>
          <div className="mono-label">Geheimnis (von Hand)</div>
          <div className="mono" style={{ margin: '4px 0 8px', wordBreak: 'break-all' }}>
            {geheimnisFormatieren(kontext.secret)}
          </div>
          <div className="muted">
            Typ: zeitbasiert (TOTP) · SHA1 · 6 Stellen · 30 Sekunden · Konto {kontext.email}
          </div>
        </div>
      </div>
      <form action={einrichtungBestaetigen} style={{ marginTop: 14 }}>
        <label className="field">
          <span>Code aus der App</span>
          <input
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            className="mono"
            placeholder="123 456"
          />
        </label>
        <button className="primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          Einrichtung abschließen
        </button>
      </form>
      <form action={abbrechen} style={{ marginTop: 10 }}>
        <button className="small" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          Abbrechen und abmelden
        </button>
      </form>
    </LoginRahmen>
  )
}
