import Link from 'next/link'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess } from '@/modules/auth/permissions'
import { befehlsKatalog } from '@/modules/befehle'
import { Befehlsfeld } from '@/components/befehlsfeld'
import { money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Daily Routine statt Kachel-Moloch: man kommt ins System, um EINEN Task zu
 * machen. Deshalb steht ein Befehlsfeld im Zentrum (Aktion tippen → Maske
 * steht; Beleg tippen → Detailseite; Freitext → KI), darunter das, was das
 * System HEUTE von einem braucht (Signalkarten, nur mit Handlungsbedarf),
 * und was dieser Benutzer oft nutzt (lernend, nutzungs_zaehler je Benutzer).
 */

function gruss(): string {
  const stunde = new Date().getHours()
  if (stunde < 11) return 'Guten Morgen'
  if (stunde < 18) return 'Guten Tag'
  return 'Guten Abend'
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ verweigert?: string }>
}) {
  const user = await requireUser()
  const { verweigert } = await searchParams
  const sees = (area: Area) => canAccess(user.role, area)

  // Chamäleon: Signale und Seiten sind eine Projektion der aktiven Prozesse.
  const prozessBereiche = new Set(
    (await sql<{ bereich: string }[]>`
      select distinct bereich from prozesse where aktiv`).map((b) => b.bereich),
  )
  const prozessAktiv = (bereich: string) => prozessBereiche.has(bereich)

  // --- Was HEUTE ansteht: nur Karten mit Handlungsbedarf -------------------
  const [s] = await sql<
    {
      freigaben: number
      zulauf_ueberfaellig: number
      versandbereit: number
      beschaffung: number
      fehler: number
      abwesenheiten: number
      tickets: number
      offene_auftraege: number
      umsatz_monat: number
    }[]
  >`
    select
      (select count(*) from purchase_orders po
        where po.state in ('draft','sent') and einkauf_freigabe_noetig(po.id))::int as freigaben,
      (select count(*) from stock_pickings p
         join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'receipt'
         left join purchase_orders po on p.origin_model = 'purchase_order' and po.id = p.origin_id
        where p.state not in ('done','cancel')
          and coalesce(po.eta_confirmed::timestamptz, p.scheduled_date) < now())::int
        as zulauf_ueberfaellig,
      (select count(*) from shipping_ready)::int as versandbereit,
      (select count(*) from orderpoint_suggestions())::int as beschaffung,
      ((select count(*) from integration_jobs where status = 'failed')
       + (select count(*) from shopify_unmatched_lines where resolved_at is null))::int as fehler,
      (select count(*) from absences where state = 'requested')::int as abwesenheiten,
      (select count(*) from bug_reports where status in ('offen','in_arbeit'))::int as tickets,
      (select count(*) from sales_orders
        where state = 'sale' and delivery_status <> 'full')::int as offene_auftraege,
      coalesce((select sum((select net from sales_order_total(so.id)))
                from sales_orders so
                where so.state = 'sale' and so.order_date >= date_trunc('month', now())), 0)
        as umsatz_monat`

  // wichtig = Entscheidungssignal (Violett): hier wartet eine Freigabe auf
  // einen Menschen; warn = Betriebsstörung (Gelb); sonst Orange.
  const aufgaben: { label: string; wert: number; href: string; warn?: boolean; wichtig?: boolean }[] = [
    ...(sees('einkauf') && s.freigaben > 0
      ? [{ label: 'Bestellungen warten auf Freigabe', wert: s.freigaben, href: '/einkauf', wichtig: true }]
      : []),
    ...(sees('lager') && s.zulauf_ueberfaellig > 0
      ? [{ label: 'Wareneingänge überfällig', wert: s.zulauf_ueberfaellig, href: '/lager/zulauf', warn: true }]
      : []),
    ...(sees('integrationen') && s.fehler > 0
      ? [{ label: 'Integrationen brauchen Aufmerksamkeit', wert: s.fehler, href: '/integrationen', warn: true }]
      : []),
    ...(sees('versand') && prozessAktiv('versand') && s.versandbereit > 0
      ? [{ label: 'Versandbereit', wert: s.versandbereit, href: '/versand' }]
      : []),
    ...(sees('lager') && (prozessAktiv('einkauf') || prozessAktiv('fertigung')) && s.beschaffung > 0
      ? [{ label: 'Beschaffungsvorschläge', wert: s.beschaffung, href: '/lager/beschaffung' }]
      : []),
    ...(sees('personal') && s.abwesenheiten > 0
      ? [{ label: 'Abwesenheitsanträge', wert: s.abwesenheiten, href: '/personal/abwesenheiten', wichtig: true }]
      : []),
    ...(sees('fehler') && s.tickets > 0
      ? [{ label: 'Offene Tickets', wert: s.tickets, href: '/tickets' }]
      : []),
  ]

  // --- Befehlsfeld-Katalog: dieselbe Quelle wie das Strg+K-Overlay ---------
  const { aktionen, seiten } = befehlsKatalog(user.role, prozessAktiv)

  // --- Lern-Gedächtnis: was DIESER Benutzer oft nutzt ----------------------
  const nutzung = await sql<{ art: string; schluessel: string; anzahl: number }[]>`
    select art, schluessel, anzahl from nutzungs_zaehler
    where user_id = ${user.id} order by anzahl desc, zuletzt desc limit 40`
  const gewichte = Object.fromEntries(nutzung.map((n) => [n.schluessel, Number(n.anzahl)]))
  const erlaubteAktionen = new Set(aktionen.map((a) => a.name))
  const erlaubteSeiten = new Map(seiten.map((p) => [p.href, p.label]))
  const haeufig = nutzung
    .map((n) =>
      n.art === 'aktion' && erlaubteAktionen.has(n.schluessel)
        ? {
            label: aktionen.find((a) => a.name === n.schluessel)!.label,
            href: `/aktion/${encodeURIComponent(n.schluessel)}`,
          }
        : n.art === 'seite' && erlaubteSeiten.has(n.schluessel)
          ? { label: erlaubteSeiten.get(n.schluessel)!, href: n.schluessel }
          : null,
    )
    .filter((e): e is { label: string; href: string } => e !== null)
    .slice(0, 6)

  const vorname = user.name.split(' ')[0]

  return (
    <>
      {verweigert && (
        <div className="notice danger">
          Für den Bereich „{verweigert}" fehlt Ihrer Rolle die Berechtigung.
        </div>
      )}

      {/* Kopf der Daily Routine: Gruß, ein Feld, das eigene Gedächtnis. */}
      <div style={{ maxWidth: 760, margin: '6vh auto 0' }}>
        <h1 style={{ textAlign: 'center', fontSize: 26, letterSpacing: '-0.02em', marginBottom: 4 }}>
          {gruss()}, {vorname}.
        </h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0, marginBottom: 18 }}>
          Sag, was du tun willst — Aktion, Beleg oder Frage.
        </p>
        <Befehlsfeld aktionen={aktionen} seiten={seiten} gewichte={gewichte} gross />
        {haeufig.length > 0 && (
          <div
            className="actions"
            style={{ justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' }}
          >
            {haeufig.map((h) => (
              <Link key={h.href} className="btn small" href={h.href}>
                {h.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Was das System heute von dir braucht — nur echte Aufgaben. */}
      <div style={{ maxWidth: 760, margin: '32px auto 0' }}>
        {aufgaben.length > 0 ? (
          <>
            <div className="mono-label" style={{ marginBottom: 8 }}>Heute anstehend</div>
            <div className="grid-3">
              {aufgaben.map((a) => (
                <Link
                  key={a.label}
                  href={a.href}
                  className="card"
                  style={{ marginBottom: 0, textDecoration: 'none' }}
                >
                  <div className="stat">
                    <div className="label">
                      <span className={`led ${a.wichtig ? 'wichtig' : a.warn ? 'warn' : 'on'}`} /> {a.label}
                    </div>
                    <div className="value">{a.wert}</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        ) : (
          <p className="muted" style={{ textAlign: 'center' }}>
            <span className="led ok" /> Nichts liegt an — alle Signale sind grün.
          </p>
        )}

        {/* Eine Zeile Lage, kein Kachel-Moloch: der Rest wohnt in Auswertungen. */}
        {sees('verkauf') && (
          <p className="muted small" style={{ textAlign: 'center', marginTop: 20 }}>
            {s.offene_auftraege} offene Aufträge · Umsatz laufender Monat{' '}
            <span className="mono">{money(s.umsatz_monat)}</span> netto ·{' '}
            <Link href="/auswertungen/kennzahlen">alle Kennzahlen</Link>
          </p>
        )}
      </div>
    </>
  )
}
