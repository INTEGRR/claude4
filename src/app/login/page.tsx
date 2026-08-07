import { redirect } from 'next/navigation'
import { currentUser, login } from '@/modules/auth'
import { sql } from '@/db/client'
import { ThemeToggle } from '@/components/theme-toggle'

export const dynamic = 'force-dynamic'

async function signIn(formData: FormData) {
  'use server'
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  const user = await login(email, password)
  if (!user) redirect('/login?fehler=1')
  redirect('/')
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ fehler?: string }>
}) {
  if (await currentUser()) redirect('/')

  const params = await searchParams
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from users`

  return (
    <div className="login-wrap">
      <div className="login-card">
        {/* Typenschild wie in der Anwendung — auch der Anmeldeschirm gehört zur Maschine. */}
        <div style={{ padding: '0 2px 14px' }}>
          <div style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-0.015em' }}>
            erp<span className="muted">.system</span>
          </div>
          <div
            className="mono-label"
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}
          >
            <span className="led ok" /> System bereit
          </div>
        </div>
        <div className="card">
          <header>Anmelden</header>
          <div className="body">
            {params.fehler && (
              <div className="notice danger">E-Mail-Adresse oder Passwort ist falsch.</div>
            )}
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
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
