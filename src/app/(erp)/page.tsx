import Link from 'next/link'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess } from '@/modules/auth/permissions'
import { befehlsKatalog } from '@/modules/befehle'
import { Befehlsfeld } from '@/components/befehlsfeld'
import { money } from '@/modules/shared/format'
import { offeneVorgaenge } from '@/modules/prozesse/offene-vorgaenge'

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
  const sees = (area: Area) => canAccess(user.rollen, area)

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
      kuendigungen: number
      zahlungen_faellig: number
      unterdeckung: number
      reparaturen_arbeit: number
      reparaturen_fertig: number
      mos_offen: number
      mos_faellig: number
      eingaenge_heute: number
      posteingang: number
      wiedervorlagen: number
      gelabelt_offen: number
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
        as umsatz_monat,
      (select count(*) from vertraege v where vertrag_kuendigung_ansteht(v.id))::int as kuendigungen,
      (select count(*) from finanz_faellig(current_date + 7))::int as zahlungen_faellig,
      coalesce((select fremdkapitalbedarf from finanz_unterdeckung('base')), 0) as unterdeckung,
      -- Reparaturen: offen (neu — Retourenlabel/Annahme —, Gerät unterwegs, da,
      -- bestätigt, in Reparatur) und fertig zum Rückversand. Wie der Zähler in
      -- der Navigation, nur ohne die fertigen (eigene Karte).
      (select count(*) from repair_orders
        where state not in ('repaired', 'shipped', 'cancel'))::int as reparaturen_arbeit,
      (select count(*) from repair_orders where state = 'repaired')::int as reparaturen_fertig,
      -- Fertigung: offene Aufträge und die, deren Termin heute oder früher ist.
      (select count(*) from manufacturing_orders
        where state not in ('draft', 'done', 'cancel'))::int as mos_offen,
      (select count(*) from manufacturing_orders
        where state not in ('draft', 'done', 'cancel')
          and scheduled_date::date <= current_date)::int as mos_faellig,
      (select count(*) from stock_pickings p
         join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'receipt'
        where p.state not in ('done', 'cancel')
          and p.scheduled_date::date = current_date)::int as eingaenge_heute,
      (select count(*) from mail_threads
        where status = 'offen' and letzte_richtung = 'eingang')::int as posteingang,
      (select count(*) from wiedervorlagen
        where erledigt_am is null and faellig_am <= current_date)::int as wiedervorlagen,
      -- Label da, Ware nicht ausgebucht — Lager und Shop wissen nichts vom Versand.
      (select count(distinct p.id) from stock_pickings p
         join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
         join shipments sh on sh.picking_id = p.id and sh.state not in ('cancelled', 'failure')
        where p.state = 'assigned')::int as gelabelt_offen`

  // Offene Vorgänge je Prozess (Reparaturanfragen, Anfragen …): eine Karte je
  // Prozess mit offenen Vorgängen — Projektion der aktiven Prozesse.
  const offen = await offeneVorgaenge()
  const vorgangsKarten = (
    await sql<{ code: string; name: string; bereich: string }[]>`
      select code, name, bereich from prozesse where aktiv and modell = 'vorgang' order by name`
  )
    .filter((p) => (offen.get(p.code) ?? 0) > 0 && sees(p.bereich as Area))
    .map((p) => ({
      label: `${p.name}: offen`,
      wert: offen.get(p.code) ?? 0,
      href: `/vorgaenge/prozess/${p.code}`,
      // Eine neue Anfrage wartet auf eine Entscheidung (annehmen, Rückfrage, ablehnen).
      wichtig: true,
    }))

  // wichtig = Entscheidungssignal (Violett): hier wartet eine Freigabe auf
  // einen Menschen; warn = Betriebsstörung (Gelb); sonst Orange.
  const aufgaben: { label: string; wert: number; anzeige?: string; href: string; warn?: boolean; wichtig?: boolean }[] = [
    ...vorgangsKarten,
    ...(sees('reparatur') && prozessAktiv('reparatur') && s.reparaturen_arbeit > 0
      ? [{ label: 'Reparaturen offen', wert: s.reparaturen_arbeit, href: '/reparatur' }]
      : []),
    ...(sees('reparatur') && prozessAktiv('reparatur') && s.reparaturen_fertig > 0
      ? [{ label: 'Reparaturen fertig zum Rückversand', wert: s.reparaturen_fertig, href: '/reparatur' }]
      : []),
    ...(sees('fertigung') && prozessAktiv('fertigung') && s.mos_faellig > 0
      ? [{ label: 'Fertigungsaufträge fällig (bis heute)', wert: s.mos_faellig, href: '/fertigung', warn: true }]
      : []),
    // „offen" nur, wenn es mehr sind als die fälligen — sonst zweimal dieselbe Zahl.
    ...(sees('fertigung') && prozessAktiv('fertigung') && s.mos_offen > s.mos_faellig
      ? [{ label: 'Fertigungsaufträge offen', wert: s.mos_offen, href: '/fertigung' }]
      : []),
    ...(sees('versand') && s.gelabelt_offen > 0
      ? [{ label: 'Label da, nicht ausgebucht', wert: s.gelabelt_offen, href: '/versand', warn: true }]
      : []),
    ...(sees('lager') && s.eingaenge_heute > 0
      ? [{ label: 'Wareneingänge heute erwartet', wert: s.eingaenge_heute, href: '/lager/zulauf' }]
      : []),
    ...(sees('einkauf') && s.posteingang > 0
      ? [{ label: 'Neue Lieferanten-Mails', wert: s.posteingang, href: '/einkauf/posteingang' }]
      : []),
    ...(sees('einkauf') && s.wiedervorlagen > 0
      ? [{ label: 'Wiedervorlagen fällig', wert: s.wiedervorlagen, href: '/einkauf/wiedervorlagen', warn: true }]
      : []),
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
    ...(sees('finanzen') && s.kuendigungen > 0
      ? [{ label: 'Verträge: Kündigungsfrist läuft ab', wert: s.kuendigungen, href: '/finanzen/vertraege', wichtig: true }]
      : []),
    ...(sees('finanzen') && s.zahlungen_faellig > 0
      ? [{ label: 'Zahlungen fällig diese Woche', wert: s.zahlungen_faellig, href: '/finanzen', warn: true }]
      : []),
    // Die Entscheidung schlechthin: Fremdkapital beschaffen oder Einkauf
    // strecken — deshalb Violett, nicht Gelb.
    ...(sees('finanzen') && Number(s.unterdeckung) > 0
      ? [{
          label: 'Unterdeckung im Finanzplan',
          wert: Number(s.unterdeckung),
          anzeige: money(s.unterdeckung),
          href: '/finanzen',
          wichtig: true,
        }]
      : []),
    ...(sees('fehler') && s.tickets > 0
      ? [{ label: 'Offene Tickets', wert: s.tickets, href: '/tickets' }]
      : []),
  ]

  // --- Befehlsfeld-Katalog: dieselbe Quelle wie das Strg+K-Overlay ---------
  const { aktionen, seiten } = befehlsKatalog(user.rollen, prozessAktiv, user.befugnisse)

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
                    <div className="value">{a.anzeige ?? a.wert}</div>
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
