import type { Sql, TransactionSql } from 'postgres'

/**
 * Daten-TÜV: nächtlicher Invarianten-Check über die Kern-Ledger des Systems.
 *
 * Der Torwächter schützt die App-Schreibwege — aber Migrationen, Bugs in
 * Buchungsfunktionen oder Handeingriffe können Daten trotzdem schleichend
 * verbiegen. Diese Prüfungen stellen die Buchhaltungs-Wahrheiten sicher, auf
 * denen alles andere aufbaut. Nur lesend; ein Lauf verändert nie etwas.
 *
 * Zwei Klassen, bewusst getrennt, damit der Alarm nicht abstumpft:
 * - BEFUNDE sind Korruption (Cache ≠ Ledger): der daten_tuev-Job schlägt
 *   FEHL — roter Badge, Integrationen-Monitor. Darf es nie geben.
 * - WARNUNGEN sind Betriebszustände, die Aufmerksamkeit brauchen (negativer
 *   Bestand → Inventur; Reservierung nicht mehr gedeckt): sie stehen im
 *   Ergebnistext des grünen Jobs.
 *
 * Muster wie die Wächter-Tests: neue Invarianten kommen als weitere Prüfung
 * dazu, jede liefert menschenlesbare Zeilen.
 */

export interface TuevErgebnis {
  pruefungen: number
  /** Korruption — führt zum fehlgeschlagenen Job. */
  befunde: string[]
  /** Betriebswarnungen — sichtbar, aber kein Alarm. */
  warnungen: string[]
}

/** Läuft auf der normalen Verbindung wie in Test-Transaktionen (Rollback). */
type Client = Sql | TransactionSql

interface Pruefung {
  name: string
  art: 'befund' | 'warnung'
  lauf: (client: Client) => Promise<string[]>
}

/** Toleranz für Mengen (numeric(16,4) — hier ist jede Abweichung echt). */
const MENGEN_TOLERANZ = 0.0001

const PRUEFUNGEN: Pruefung[] = [
  {
    // Kernprinzip des Lagers: stock_quants ist nur der Cache des Ledgers.
    // Jede Abweichung zwischen Quant und Summe der gebuchten Moves ist echte
    // Korruption (direkter UPDATE, kaputte Buchungsfunktion, Migration).
    name: 'Bestand = Ledger',
    art: 'befund',
    async lauf(client) {
      const zeilen = await client<
        { sku: string | null; ort: string; quant: string; ledger: string }[]
      >`
        with bewegung as (
          select variant_id, dest_location_id as location_id, sum(qty_done) as menge
          from stock_moves where state = 'done' group by 1, 2
          union all
          select variant_id, src_location_id, -sum(qty_done)
          from stock_moves where state = 'done' group by 1, 2
        ), soll as (
          select variant_id, location_id, sum(menge) as menge
          from bewegung group by 1, 2
        )
        select v.sku, l.full_path as ort,
               coalesce(q.on_hand, 0)::text as quant,
               coalesce(s.menge, 0)::text as ledger
        from soll s
        full outer join stock_quants q using (variant_id, location_id)
        join product_variants v on v.id = coalesce(s.variant_id, q.variant_id)
        join stock_locations l on l.id = coalesce(s.location_id, q.location_id)
        where abs(coalesce(q.on_hand, 0) - coalesce(s.menge, 0)) > ${MENGEN_TOLERANZ}
        limit 20`
      return zeilen.map(
        (z) => `${z.sku ?? '?'} @ ${z.ort}: Quant ${z.quant}, Ledger ${z.ledger}`,
      )
    },
  },
  {
    // Auch die Reservierung ist nur ein Cache: Quant-reserved muss der Summe
    // der reserved_qty aller OFFENEN Moves am Quellort entsprechen
    // (move_reserve/move_unreserve pflegen beide Seiten im Gleichschritt).
    name: 'Reserviert = offene Move-Reservierungen',
    art: 'befund',
    async lauf(client) {
      const zeilen = await client<
        { sku: string | null; ort: string; quant: string; moves: string }[]
      >`
        with soll as (
          select variant_id, src_location_id as location_id, sum(reserved_qty) as menge
          from stock_moves
          where state not in ('done', 'cancel', 'draft') and reserved_qty > 0
          group by 1, 2
        )
        select v.sku, l.full_path as ort,
               coalesce(q.reserved, 0)::text as quant,
               coalesce(s.menge, 0)::text as moves
        from soll s
        full outer join stock_quants q using (variant_id, location_id)
        join product_variants v on v.id = coalesce(s.variant_id, q.variant_id)
        join stock_locations l on l.id = coalesce(s.location_id, q.location_id)
        where abs(coalesce(q.reserved, 0) - coalesce(s.menge, 0)) > ${MENGEN_TOLERANZ}
        limit 20`
      return zeilen.map(
        (z) => `${z.sku ?? '?'} @ ${z.ort}: Quant ${z.quant}, Moves ${z.moves}`,
      )
    },
  },
  {
    // Bewertungs-Ledger gegen Bestands-Ledger: die Summe aller Wertschicht-
    // Mengen je Variante muss dem bewerteten Bestand (interne + Transit-Orte)
    // entsprechen — zwei unabhängige Aufschreibungen derselben Wahrheit.
    name: 'Bewertungsschichten = bewerteter Bestand',
    art: 'befund',
    async lauf(client) {
      const zeilen = await client<
        { sku: string | null; schichten: string; bestand: string }[]
      >`
        with schichten as (
          select variant_id, sum(quantity) as menge
          from stock_valuation_layers group by 1
        ), bestand as (
          select q.variant_id, sum(q.on_hand) as menge
          from stock_quants q
          join stock_locations l on l.id = q.location_id
          where l.type in ('internal', 'transit')
          group by 1
        )
        select v.sku,
               coalesce(s.menge, 0)::text as schichten,
               coalesce(b.menge, 0)::text as bestand
        from schichten s
        full outer join bestand b using (variant_id)
        join product_variants v on v.id = coalesce(s.variant_id, b.variant_id)
        where abs(coalesce(s.menge, 0) - coalesce(b.menge, 0)) > ${MENGEN_TOLERANZ}
        limit 20`
      return zeilen.map(
        (z) => `${z.sku ?? '?'}: Schichten ${z.schichten}, Bestand ${z.bestand}`,
      )
    },
  },
  {
    // Abgeschlossene Moves ohne Menge oder Datum sind halbe Buchungen —
    // entweder war der Move nie fertig oder das Protokoll fehlt.
    name: 'Fertige Moves vollständig gebucht',
    art: 'befund',
    async lauf(client) {
      const zeilen = await client<{ anzahl: string }[]>`
        select count(*)::text as anzahl from stock_moves
        where state = 'done' and (date_done is null or qty_done <= 0)`
      const n = Number(zeilen[0]?.anzahl ?? 0)
      return n > 0 ? [`${n} done-Move(s) ohne date_done oder mit qty_done ≤ 0`] : []
    },
  },
  {
    // Belegnummern kommen seit 0026 aus PG-Sequenzen (seq_<kreis>). Steht
    // eine Sequenz hinter den vorhandenen Belegen (Import, Handeingriff),
    // crasht der NÄCHSTE neue Beleg mit einer Duplikat-Nummer — auf der
    // Odoo-importierten Instanz genau so passiert (seq_sale bei 1, Belege
    // bis S01877). Die nächste vergebene Nummer muss je Kreis über dem
    // höchsten Beleg liegen, der dem Muster des Kreises entspricht.
    name: 'Nummernkreise vor dem Belegbestand',
    art: 'befund',
    async lauf(client) {
      const kreise = [
        { code: 'sale', tabelle: 'sales_orders' },
        { code: 'purchase', tabelle: 'purchase_orders' },
        { code: 'mo', tabelle: 'manufacturing_orders' },
      ]
      const treffer: string[] = []
      for (const k of kreise) {
        const [zeile] = (await client.unsafe(`
          with stand as (
            select prefix, padding, next_number from sequence_state()
            where code = '${k.code}')
          select s.prefix, s.padding, s.next_number::text as naechste,
                 coalesce(max((regexp_match(t.number,
                   '^' || s.prefix || '([0-9]+)$'))[1]::bigint), 0)::text as max_nr
          from stand s
          left join ${k.tabelle} t on t.number like s.prefix || '%'
          group by s.prefix, s.padding, s.next_number`)) as {
          prefix: string
          padding: number
          naechste: string
          max_nr: string
        }[]
        if (!zeile) continue
        if (Number(zeile.max_nr) >= Number(zeile.naechste)) {
          const pad = (n: string) => zeile.prefix + n.padStart(zeile.padding, '0')
          treffer.push(
            `${k.code}: nächste Nummer wäre ${pad(zeile.naechste)}, höchster Beleg ist ${pad(zeile.max_nr)}`,
          )
        }
      }
      return treffer
    },
  },
  {
    // Physisch kann ein Regal nicht weniger als nichts enthalten. Fachlich
    // erlaubt das System Überbuchung (liefern, was gleich ankommt) — deshalb
    // Warnung, nicht Befund: der Zustand heißt „Inventur nötig".
    name: 'Negativer Bestand an internen Orten',
    art: 'warnung',
    async lauf(client) {
      const zeilen = await client<{ sku: string | null; ort: string; on_hand: string }[]>`
        select v.sku, l.full_path as ort, q.on_hand::text
        from stock_quants q
        join stock_locations l on l.id = q.location_id
        join product_variants v on v.id = q.variant_id
        where l.type = 'internal' and q.on_hand < -(${MENGEN_TOLERANZ})::numeric
        limit 20`
      return zeilen.map((z) => `${z.sku ?? '?'} @ ${z.ort}: ${z.on_hand}`)
    },
  },
  {
    // move_reserve deckelt auf die Verfügbarkeit — mehr reserviert als da
    // entsteht nur NACHTRÄGLICH (Verbrauch an der Reservierung vorbei).
    // Die versprochene Ware fehlt dann wirklich: Nachschub oder Inventur.
    name: 'Reservierung übersteigt Bestand',
    art: 'warnung',
    async lauf(client) {
      const zeilen = await client<
        { sku: string | null; ort: string; on_hand: string; reserved: string }[]
      >`
        select v.sku, l.full_path as ort, q.on_hand::text, q.reserved::text
        from stock_quants q
        join stock_locations l on l.id = q.location_id
        join product_variants v on v.id = q.variant_id
        where q.reserved < 0
           or (l.type = 'internal' and q.reserved > q.on_hand + ${MENGEN_TOLERANZ})
        limit 20`
      return zeilen.map(
        (z) => `${z.sku ?? '?'} @ ${z.ort}: reserviert ${z.reserved} bei Bestand ${z.on_hand}`,
      )
    },
  },
]

export async function datenTuev(client: Client): Promise<TuevErgebnis> {
  const befunde: string[] = []
  const warnungen: string[] = []
  for (const p of PRUEFUNGEN) {
    const treffer = await p.lauf(client)
    const ziel = p.art === 'befund' ? befunde : warnungen
    ziel.push(...treffer.map((t) => `${p.name}: ${t}`))
  }
  return { pruefungen: PRUEFUNGEN.length, befunde, warnungen }
}
