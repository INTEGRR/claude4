import Link from 'next/link'
import { LABELS, dateTime, money, tone } from '@/modules/shared/format'

export function Badge({ state, kind }: { state: string; kind: keyof typeof LABELS }) {
  const labels = LABELS[kind] as Record<string, string>
  return <span className={`badge ${tone(state)}`}>{labels[state] ?? state}</span>
}

export function Card({
  title,
  actions,
  children,
  tight,
}: {
  title?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  tight?: boolean
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header>
          <span>{title}</span>
          {actions && <span className="actions">{actions}</span>}
        </header>
      )}
      <div className={tight ? 'body tight' : 'body'}>{children}</div>
    </section>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && (
          <div className="muted small" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  href,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  href?: string
}) {
  const body = (
    <div className="card" style={{ marginBottom: 0, height: '100%' }}>
      <div className="stat">
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
    </div>
  )
  return href ? (
    <Link href={href} style={{ color: 'inherit' }}>
      {body}
    </Link>
  ) : (
    body
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

/** Tabelle mit horizontalem Scroll — Belegtabellen werden schnell breit. */
export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="table-wrap">{children}</div>
}

export function Money({ value, currency }: { value: number | string | null; currency?: string }) {
  return <span className="nowrap">{money(value, currency)}</span>
}

export interface LogEntry {
  id: string | number
  kind: string
  message: string
  actor: string | null
  created_at: string
}

/** Beleg-Verlauf: Statuswechsel, Notizen, E-Mails. */
export function AuditLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <Empty>Noch keine Einträge.</Empty>
  return (
    <ul className="log">
      {entries.map((e) => (
        <li key={e.id}>
          <div className={e.kind === 'error' ? 'badge danger' : undefined}>{e.message}</div>
          <div className="meta">
            {dateTime(e.created_at)} · {e.actor ?? 'system'}
          </div>
        </li>
      ))}
    </ul>
  )
}
