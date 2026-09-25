import { redirect } from 'next/navigation'
import { currentUser, login, wartenderNutzer } from '@/modules/auth'
import { sql } from '@/db/client'
import { LoginRahmen } from './rahmen'

export const dynamic = 'force-dynamic'

async function signIn(formData: FormData) {
  'use server'
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  const ergebnis = await login(email, password)
  if (ergebnis === 'gesperrt') redirect('/login?fehler=gesperrt')
  if (!ergebnis) redirect('/login?fehler=1')
  // Zweiter Schritt: die wartende Sitzung liegt bereits im Cookie.
  if ('schritt' in ergebnis) redirect(ergebnis.schritt === 'code' ? '/login/code' : '/login/einrichten')
  redirect('/')
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ fehler?: string }>
}) {
  if (await currentUser()) redirect('/')
  // Passwort schon geprüft, Code fehlt noch: nicht das Formular zeigen,
  // sondern dort weitermachen, wo die Anmeldung steht.
  const wartend = await wartenderNutzer()
  if (wartend) redirect(wartend.totpAktiv ? '/login/code' : '/login/einrichten')

  const params = await searchParams
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from users`

  return (
    <LoginRahmen titel="Anmelden">
      {params.fehler === 'gesperrt' ? (
        <div className="notice danger">
          Zu viele Fehlversuche — die Anmeldung ist für dieses Konto 15 Minuten gesperrt.
        </div>
      ) : params.fehler === 'abgelaufen' ? (
        <div className="notice warn">
          Die Anmeldung ist abgelaufen — bitte erneut anmelden.
        </div>
      ) : params.fehler ? (
        <div className="notice danger">E-Mail-Adresse oder Passwort ist falsch.</div>
      ) : null}
      {count === 0 && (
        <div className="notice warn">
          Es existiert noch kein Benutzer. Lege einen an mit:
          <br />
          <code className="mono">npm run db:seed</code>
        </div>
      )}
      <form action={signIn}>
        <label className="field">
          <span>E-Mail</span>
          <input type="email" name="email" required autoFocus autoComplete="username" />
        </label>
        <label className="field">
          <span>Passwort</span>
          <input type="password" name="password" required autoComplete="current-password" />
        </label>
        <button className="primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          Anmelden
        </button>
      </form>
    </LoginRahmen>
  )
}
