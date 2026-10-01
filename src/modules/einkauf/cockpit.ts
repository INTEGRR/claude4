import type { Sql, TransactionSql } from 'postgres'
import { telegramSicher } from '../integrationen/telegram.ts'

/**
 * Einkaufs-Cockpit (0108): was im Einkauf ansteht, je Einkäufer — die eine
 * Quelle für /einkauf/cockpit und die tägliche Telegram-Zusammenfassung
 * (Job einkauf_digest). Bewusst ohne '@/'-Importe (Client als Parameter),
 * damit Laden und Text unter blankem Node bzw. im Prozesstest laufen.
 *
 * Die Einträge kommen aus der Sicht einkauf_cockpit; fällige Zahlplan-Raten
 * sind Finanzdaten und werden nur mit Finanzrecht dazugeladen (die KI-
 * Finanzsperre greift auf Tabellennamen — deshalb nicht in der Sicht).
 */

type Db = Sql | TransactionSql

export const COCKPIT_KATEGORIEN = {
  ueberfaellig: { label: 'Überfällig', hinweis: 'Wiedervorlagen und Fristen, die verstrichen sind', digest: true },
  heute: { label: 'Heute fällig', hinweis: 'Wiedervorlagen für heute', digest: true },
  eta_ueberfaellig: { label: 'Überfällige ETA', hinweis: 'Liefertermin verstrichen, Wareneingang offen', digest: true },
  dokumente: { label: 'Fehlende Dokumente', hinweis: 'PI, CI, Packing List, Endrechnung, Fracht- und Zollbelege', digest: true },
  rechnungen: { label: 'Fehlende Rechnungen', hinweis: 'Ware da, Lieferantenrechnung fehlt', digest: true },
  raten: { label: 'Fällige Raten', hinweis: 'Zahlplan-Raten der nächsten 7 Tage', digest: true },
  wartet_uns: { label: 'Wartet auf uns', hinweis: 'Letzte Nachricht kam vom Lieferanten', digest: true },
  wartet_lieferant: { label: 'Wartet auf Lieferant', hinweis: 'Wir haben zuletzt geschrieben', digest: false },
  unzugeordnet: { label: 'Nicht zugeordnete Mails', hinweis: 'Posteingang ohne Lieferant, Bestellung oder Projekt', digest: true },
  // Einkaufs-Agent (0109): Arbeitsvorrat, kein Termin — deshalb nicht im Digest.
  ki_vorschlaege: {
    label: 'KI-Vorschläge offen',
    hinweis: 'Vom Einkaufs-Agenten vorbereitet: annehmen, ändern oder verwerfen (offene KI-Entwürfe unter Mail-Entwürfe)',
    digest: false,
  },
  sendungen: { label: 'Laufende Sendungen', hinweis: 'Geplant, unterwegs, verzollt oder angekommen', digest: false },
  muster: { label: 'Laufende Muster', hinweis: 'Angefordert oder eingegangen, noch nicht bewertet', digest: false },
  werkzeuge: { label: 'Werkzeuge am Lebensende', hinweis: 'Ab 90 % der Schuss-Lebensdauer', digest: true },
} as const
export type CockpitKategorie = keyof typeof COCKPIT_KATEGORIEN
export const COCKPIT_REIHENFOLGE = Object.keys(COCKPIT_KATEGORIEN) as CockpitKategorie[]

export interface CockpitEintrag {
  kategorie: CockpitKategorie
  modell: string
  record_id: string
  titel: string
  detail: string | null
  link: string
  /** JJJJ-MM-TT */
  faellig_am: string | null
  zustaendig_id: string | null
  partner_id: string | null
}

/**
 * Lädt das Cockpit. `zustaendigId` = nur Einträge dieses Einkäufers (nicht
 * zugeordnete Mails gehören niemandem und stehen immer dabei); ohne = alle.
 * `finanzen` = fällige Zahlplan-Raten mitladen.
 */
export async function cockpitLaden(
  db: Db,
  opts: { zustaendigId?: string | null; finanzen: boolean },
): Promise<CockpitEintrag[]> {
  const nur = opts.zustaendigId ?? null
  const eintraege = await db<CockpitEintrag[]>`
    select c.kategorie, c.modell, c.record_id, c.titel, c.detail, c.link,
           to_char(c.faellig_am, 'YYYY-MM-DD') as faellig_am, c.zustaendig_id, c.partner_id
    from einkauf_cockpit c
    where ${nur}::uuid is null or c.zustaendig_id = ${nur}::uuid or c.kategorie = 'unzugeordnet'
    order by c.faellig_am nulls last, c.titel`

  // Offene Vorschläge des Agenten (0109) — je Beleg, an dem sie erscheinen:
  // Thread, sonst Projekt, Bestellung, Lieferant. Zuständig ist der des
  // Threads bzw. der Einkäufer des Lieferanten.
  const vorschlaege = await db<CockpitEintrag[]>`
    select 'ki_vorschlaege' as kategorie,
           case when v.thread_id is not null then 'mail_thread'
                when v.einkaufsprojekt_id is not null then 'einkaufsprojekt'
                when v.purchase_order_id is not null then 'purchase_order' else 'partner' end as modell,
           coalesce(v.thread_id, v.einkaufsprojekt_id, v.purchase_order_id, v.partner_id) as record_id,
           v.titel,
           concat_ws(' · ', pa.name, case when v.status = 'fehler' then 'Annehmen gescheitert' end) as detail,
           case when v.thread_id is not null then '/einkauf/posteingang/' || v.thread_id
                when v.einkaufsprojekt_id is not null then '/einkauf/projekte/' || v.einkaufsprojekt_id
                when v.purchase_order_id is not null then '/einkauf/' || v.purchase_order_id
                else '/einkauf/lieferanten/' || v.partner_id end || '#ki-vorschlaege' as link,
           to_char(v.erstellt_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as faellig_am,
           coalesce(t.zustaendig_id, pa.einkaeufer_id) as zustaendig_id, v.partner_id
    from ki_vorschlaege v
    left join mail_threads t on t.id = v.thread_id
    left join partners pa on pa.id = v.partner_id
    where v.status in ('offen', 'fehler')
      and coalesce(v.thread_id, v.einkaufsprojekt_id, v.purchase_order_id, v.partner_id) is not null
      and (${nur}::uuid is null or coalesce(t.zustaendig_id, pa.einkaeufer_id) = ${nur}::uuid
           or coalesce(t.zustaendig_id, pa.einkaeufer_id) is null)
    order by v.erstellt_am desc
    limit 200`
  if (!opts.finanzen) return [...eintraege, ...vorschlaege]

  const raten = await db<CockpitEintrag[]>`
    select 'raten' as kategorie, 'purchase_order' as modell, po.id as record_id,
           po.number || ' — ' || r.bezeichnung as titel,
           pa.name || ' · ' || money_text(zahlplan_betrag(r)) as detail,
           '/einkauf/' || po.id as link,
           to_char(zahlplan_faelligkeit(r), 'YYYY-MM-DD') as faellig_am,
           coalesce(po.user_id, pa.einkaeufer_id) as zustaendig_id, po.vendor_id as partner_id
    from zahlplan_raten r
    join purchase_orders po on po.id = r.purchase_order_id
    join partners pa on pa.id = po.vendor_id
    where r.bezahlt_am is null and po.state not in ('cancel', 'done')
      and zahlplan_faelligkeit(r) <= current_date + 7
      and (${nur}::uuid is null or coalesce(po.user_id, pa.einkaeufer_id) = ${nur}::uuid)
    order by zahlplan_faelligkeit(r)`
  return [...eintraege, ...vorschlaege, ...raten]
}

/** Je Kategorie in fester Reihenfolge, leere weggelassen. */
export function cockpitGruppieren(eintraege: CockpitEintrag[]): { kategorie: CockpitKategorie; eintraege: CockpitEintrag[] }[] {
  return COCKPIT_REIHENFOLGE.map((kategorie) => ({
    kategorie,
    eintraege: eintraege.filter((e) => e.kategorie === kategorie),
  })).filter((g) => g.eintraege.length > 0)
}

const OHNE = '—'
const JE_KATEGORIE = 5

function datumKurz(iso: string): string {
  const [j, m, t] = iso.split('-')
  return `${t}.${m}.${j}`
}

/**
 * Text der täglichen Zusammenfassung (Telegram, HTML-Modus): je Einkäufer
 * die handlungsrelevanten Kategorien mit Anzahl und den ersten fünf
 * Einträgen, „Ohne Zuständigen" zuletzt, nicht zugeordnete Mails nur als
 * Zahl. Laufende Sendungen, Muster und „wartet auf Lieferant" sind Lage,
 * kein Auftrag — sie stehen im Cockpit, nicht in der Nachricht. Nichts zu
 * tun → null (dann geht keine Nachricht raus). `basisUrl` macht die Belege
 * klickbar.
 */
export function digestText(
  eintraege: CockpitEintrag[],
  namen: Record<string, string>,
  opts: { datum: string; basisUrl?: string | null; maxZeichen?: number } = { datum: new Date().toISOString().slice(0, 10) },
): string | null {
  const relevant = eintraege.filter((e) => COCKPIT_KATEGORIEN[e.kategorie]?.digest)
  if (relevant.length === 0) return null

  const gruppen = new Map<string, CockpitEintrag[]>()
  for (const e of relevant) {
    const schluessel = e.kategorie === 'unzugeordnet' ? OHNE : (e.zustaendig_id ?? OHNE)
    gruppen.set(schluessel, [...(gruppen.get(schluessel) ?? []), e])
  }
  const name = (id: string) => (id === OHNE ? 'Ohne Zuständigen' : (namen[id] ?? 'Unbekannt'))
  const reihenfolge = [...gruppen.keys()].sort((a, b) => {
    if (a === OHNE) return 1
    if (b === OHNE) return -1
    return name(a).localeCompare(name(b), 'de')
  })

  const basis = opts.basisUrl?.replace(/\/$/, '')
  const verweis = (e: CockpitEintrag) =>
    basis ? `<a href="${telegramSicher(`${basis}${e.link}`)}">${telegramSicher(e.titel)}</a>` : telegramSicher(e.titel)

  const zeilen: string[] = [`📋 <b>Einkauf — ${datumKurz(opts.datum)}</b>`]
  for (const id of reihenfolge) {
    const liste = gruppen.get(id)!
    zeilen.push('', `<b>${telegramSicher(name(id))}</b> (${liste.length})`)
    for (const g of cockpitGruppieren(liste)) {
      const k = COCKPIT_KATEGORIEN[g.kategorie]
      if (g.kategorie === 'unzugeordnet') {
        zeilen.push(`• ${k.label}: ${g.eintraege.length}`)
        continue
      }
      zeilen.push(`• ${k.label} (${g.eintraege.length})`)
      for (const e of g.eintraege.slice(0, JE_KATEGORIE)) {
        const wann = e.faellig_am ? ` · ${datumKurz(e.faellig_am)}` : ''
        zeilen.push(`  – ${verweis(e)}${telegramSicher(wann)}`)
      }
      if (g.eintraege.length > JE_KATEGORIE) zeilen.push(`  – … und ${g.eintraege.length - JE_KATEGORIE} weitere`)
    }
  }
  if (basis) zeilen.push('', `<a href="${telegramSicher(`${basis}/einkauf/cockpit`)}">Cockpit öffnen</a>`)

  const max = opts.maxZeichen ?? 3500
  let text = zeilen.join('\n')
  if (text.length > max) {
    // An einer Zeilengrenze kürzen (kein halbes HTML-Tag), Hinweis anhängen.
    const gekuerzt: string[] = []
    let laenge = 0
    for (const z of zeilen) {
      if (laenge + z.length + 1 > max - 60) break
      gekuerzt.push(z)
      laenge += z.length + 1
    }
    text = `${gekuerzt.join('\n')}\n… gekürzt — der Rest steht im Cockpit.`
  }
  return text
}
