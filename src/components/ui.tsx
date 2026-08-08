import Link from 'next/link'
import { LABELS, dateTime, money, tone } from '@/modules/shared/format'

/**
 * Leuchte je Tonlage. Konvention im ganzen Haus:
 *   on   = läuft gerade / kritisch (der einzige legitime Orange-Fall)
 *   ok   = gut, erledigt
 *   warn = Ausnahme, Fehler, Abbruch
 *   off  = neutral, inaktiv
 * Für "info" gibt es keine eigene Klasse — die Farbe kommt als Token dazu.
 */
const LED_BY_TONE: Record<ReturnType<typeof tone>, { cls: string; color?: string }> = {
  success: { cls: 'led ok' },
  info: { cls: 'led', color: 'var(--info)' },
  warn: { cls: 'led warn' },
  danger: { cls: 'led warn' },
  neutral: { cls: 'led off' },
}

/**
 * Status-Typenschild. Mit `led` kommt die Statusleuchte davor — gedacht für
 * den Kopf-Status einer Detailseite. In Tabellen bleibt das Schild allein,
 * sonst flimmert die ganze Liste.
 */
export function Badge({ state, kind, led }: { state: string; kind: keyof typeof LABELS; led?: boolean }) {
  const labels = LABELS[kind] as Record<string, string>
  const t = tone(state)
  const badge = <span className={`badge ${t}`}>{labels[state] ?? state}</span>
  if (!led) return badge
  const lamp = LED_BY_TONE[t]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={lamp.cls} style={lamp.color ? { background: lamp.color } : undefined} />
      {badge}
    </span>
  )
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

/**
 * Seitenkopf. `kicker` ist die Typenschild-Zeile über dem Titel (Belegart,
 * z. B. "Warenausgang"), `mono` setzt den Titel in Monospace — für
 * Belegnummern wie WH/OUT/00001, die keine Fließtextschrift vertragen.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  kicker,
  mono,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  kicker?: React.ReactNode
  mono?: boolean
}) {
  // Die Maße stehen bewusst im Stylesheet (.page-head) und nicht hier inline:
  // sonst könnten die Medienabfragen den Kopf auf schmalen Geräten nicht mehr
  // umbauen — Inline-Stil schlägt jede Regel.
  return (
    <div className="page-head">
      <div className="page-head-titel">
        {kicker && <div className="mono-label">{kicker}</div>}
        <h1 className={mono ? 'mono' : undefined}>{title}</h1>
        {subtitle && <div className="muted small">{subtitle}</div>}
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

/** Art des Eintrags als Typenschild vor der Meldung. */
const LOG_LABELS: Record<string, string> = {
  state: 'Status',
  note: 'Notiz',
  email: 'E-Mail',
  error: 'Fehler',
}

/**
 * Beleg-Verlauf: Statuswechsel, Notizen, E-Mails.
 * Die Meldung bleibt Fließtext und umbricht; die Art der Zeile steht als
 * Mono-Label davor. Eine Leuchte bekommt nur der Fehler — bei allen anderen
 * Zeilen wäre sie nur ein zweiter Punkt neben dem Verlaufspunkt.
 */
export function AuditLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <Empty>Noch keine Einträge.</Empty>
  return (
    <ul className="log">
      {entries.map((e) => (
        <li key={e.id}>
          <div>
            {e.kind === 'error' && <span className="led warn" style={{ marginRight: 6 }} />}
            <span className="mono-label" style={{ marginRight: 6 }}>
              {LOG_LABELS[e.kind] ?? e.kind}
            </span>
            {e.message}
          </div>
          <div className="meta">
            {dateTime(e.created_at)} · {e.actor ?? 'system'}
          </div>
        </li>
      ))}
    </ul>
  )
}
