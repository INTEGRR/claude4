import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { nachAnfrageVersenden } from '@/modules/integrationen/benachrichtigungen-versand'
import { logout, wartenderNutzer, zweitenFaktorPruefen } from '@/modules/auth'
import { LoginRahmen } from '../rahmen'

/**
 * Zweiter Schritt der Anmeldung: der Code aus der Authenticator-App (oder
 * ein Backup-Code) bestätigt die wartende Sitzung. Rahmen-Aktion wie
 * login:signIn — Sitzung, keine Fachaktion an einem Beleg.
 */

export const dynamic = 'force-dynamic'

async function codePruefen(formData: FormData) {
  'use server'
  // Telegram-Meldungen (Anmeldung, Fehlversuch) sofort nach der Antwort
  // senden — die Outbox bleibt die Wahrheit, der Cron holt den Rest.
  after(nachAnfrageVersenden)
  const code = String(formData.get('code') ?? '')
  const merken = formData.get('merken') === 'on'
  const ergebnis = await zweitenFaktorPruefen(code, merken)
  if (ergebnis === 'ok') redirect('/')
  if (ergebnis === 'keine_sitzung') redirect('/login?fehler=abgelaufen')
  if (ergebnis === 'nicht_eingerichtet') redirect('/login/einrichten')
  redirect(`/login/code?fehler=${ergebnis}`)
}

async function abbrechen() {
  'use server'
  await logout()
  redirect('/login')
}

export default async function CodeSeite({
  searchParams,
}: {
  searchParams: Promise<{ fehler?: string }>
}) {
  const wartend = await wartenderNutzer()
  if (!wartend) redirect('/login')
  if (!wartend.totpAktiv) redirect('/login/einrichten')
  const { fehler } = await searchParams

  return (
    <LoginRahmen titel="Zweiter Faktor" status={`Angemeldet als ${wartend.name} — Code fehlt`}>
      {fehler === 'gesperrt' ? (
        <div className="notice danger">
          Zu viele Fehlversuche — die Anmeldung ist für dieses Konto 15 Minuten gesperrt.
        </div>
      ) : fehler ? (
        <div className="notice danger">Der Code ist falsch oder schon verbraucht.</div>
      ) : null}
      <p className="small muted" style={{ marginTop: 0 }}>
        Bitte den sechsstelligen Code aus der Authenticator-App eingeben. Ohne Telefon: einen
        der Backup-Codes (Form <span className="mono">xxxx-xxxx</span>), jeder gilt einmal.
      </p>
      <form action={codePruefen}>
        <label className="field">
          <span>Code</span>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px' }}>
          <input type="checkbox" name="merken" />
          <span className="small">Dieses Gerät 30 Tage merken (kein Code auf diesem Browser)</span>
        </label>
        <button className="primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          Bestätigen
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
