import { ThemeToggle } from '@/components/theme-toggle'
import { HexcoreMark, Wortmarke } from '@/components/marke'

/**
 * Der Rahmen aller Anmeldeschirme (Passwort, Code, Einrichtung): Typenschild
 * wie in der Anwendung — auch der Anmeldeschirm gehört zur Maschine.
 */
export function LoginRahmen({
  titel,
  status = 'System bereit',
  breit = false,
  children,
}: {
  titel: string
  status?: string
  /** Die Einrichtung braucht Platz für QR-Code und Geheimnis. */
  breit?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="login-wrap">
      <div className="login-card" style={breit ? { maxWidth: 560 } : undefined}>
        <div style={{ padding: '0 2px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HexcoreMark groesse={26} />
            <Wortmarke groesse={20} />
          </div>
          <div
            className="mono-label"
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
          >
            <span className="led ok" /> {status}
          </div>
        </div>
        <div className="card">
          <header>{titel}</header>
          <div className="body">{children}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
