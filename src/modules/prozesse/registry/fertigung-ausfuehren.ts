import { sql, tx } from '@/db/client'
import { drucken, zielDrucker } from '@/modules/druck/auftrag'
import { varianteAufloesen } from './aufloesen.ts'
import { fertigungsNachfrageAbhaken } from '@/modules/verkauf/extern-versand'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'
import { plural, schreibschutzPruefen } from '@/modules/shared/format'

/** Ausführung der Fertigungs-Aktionen — Fachlogik unverändert aus fertigung/actions.ts. */

export async function auftragAnlegen(
  p: { variant_id: string; qty: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // variant_id ist ein Kennungsfeld: die Maske liefert die UUID, die KI
  // darf SKU/Barcode/Name sagen — aufgelöst wird hier (aufloesen.ts).
  const produkt = await varianteAufloesen(sql, p.variant_id)
  const [row] = await sql<{ create_manufacturing_order: string }[]>`
    select create_manufacturing_order(${produkt.id}, ${p.qty}, null, null, ${ctx.actor})`
  const [mo] = await sql<{ number: string }[]>`
    select number from manufacturing_orders where id = ${row.create_manufacturing_order}`
  return {
    text: `Fertigungsauftrag ${mo.number} für ${produkt.name} angelegt.`,
    link: `/fertigung/${row.create_manufacturing_order}`,
    recordId: row.create_manufacturing_order,
  }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_confirm(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function beginnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_start(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/**
 * Fertigungszettel drucken (Bulk und Knopf am Auftrag): je Auftrag an den
 * A4-Drucker des Arbeitsplatzes, sonst an den Ersatz (0087). Ohne Drucker
 * gibt es den Link auf den Browser-Sammeldruck — der Knopf tut dann
 * sichtbar das Nächstbeste.
 */
export async function zettelDrucken(
  p: { ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'fertigungszettel')
  let meldung: string | null = null
  for (const moId of p.ids) {
    const druck = await drucken(
      'fertigungszettel',
      { art: 'zettel', moId },
      { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
      ziel,
    )
    if (!druck.gedruckt) {
      return {
        text: 'Kein Drucker für Fertigungszettel — Sammeldruck im Browser geöffnet (einrichten: Einstellungen → Arbeitsplätze).',
        link: `/fertigung/druck?ids=${p.ids.join(',')}`,
      }
    }
    meldung = druck.meldung
  }
  return { text: `${p.ids.length} Zettel: ${meldung ?? 'nichts zu drucken.'}` }
}

/**
 * Fertigungsetiketten (Knopf am Auftrag und Bulk): je Auftrag ein Etikett
 * am Etikettendrucker des Arbeitsplatzes, sonst am Ersatz (0087) — im
 * Format dieses Druckers. Ohne Drucker gibt es den Link aufs PDF im
 * Browser (Standardformat 100 × 50 mm), wie beim Zettel.
 */
export async function etikettDrucken(
  p: { ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const gewuenscht = [...new Set(p.ids)]
  const vorhanden = await sql<{ id: string }[]>`
    select id from manufacturing_orders where id = any(${gewuenscht}::uuid[])`
  const ids = gewuenscht.filter((id) => vorhanden.some((v) => v.id === id))
  if (ids.length === 0) throw new Error('Keiner der Fertigungsaufträge wurde gefunden.')
  const stueck = `${ids.length} Fertigungsetikett${ids.length === 1 ? '' : 'en'}`

  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'fertigungsetikett')
  if (!ziel) {
    return {
      text: `${stueck} — kein Etikettendrucker für Fertigungsetiketten, PDF im Browser geöffnet (einrichten: Einstellungen → Arbeitsplätze & Drucker).`,
      link: `/api/etikett/fertigung?ids=${ids.join(',')}`,
    }
  }
  let meldung = ''
  let wartete = 0
  for (const moId of ids) {
    const druck = await drucken(
      'fertigungsetikett',
      { art: 'fertigungsetikett', moId },
      { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
      ziel,
    )
    if (druck.gedruckt) {
      meldung = druck.meldung
      if (druck.wartete) wartete++
    }
  }
  const doppelt = wartete > 0 ? ` ${wartete} davon lag${wartete === 1 ? '' : 'en'} schon in der Warteschlange.` : ''
  return { text: `${stueck}: ${meldung}${doppelt}` }
}

/**
 * Bulk-Start (BUG/00003): jeden Auftrag einzeln starten — startbar ist,
 * was bestätigt ist und dessen Material vollständig reserviert wurde.
 * Wer zwischen Druck und Start herausgefallen ist, wird übersprungen und
 * namentlich gemeldet; ein Einzelfehler bricht den Lauf nicht ab.
 */
export async function massenstart(
  p: { ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const kandidaten = await sql<{ id: string; number: string; state: string; missing: number }[]>`
    select mo.id, mo.number, mo.state,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done', 'cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    where mo.id = any(${p.ids})`

  const gestartet: string[] = []
  const uebersprungen: string[] = []
  for (const mo of kandidaten) {
    if (mo.state !== 'confirmed') {
      uebersprungen.push(`${mo.number} (Status ${mo.state})`)
      continue
    }
    if (mo.missing > 0) {
      uebersprungen.push(`${mo.number} (Material nicht vollständig reserviert)`)
      continue
    }
    try {
      await sql`select mo_start(${mo.id}, ${ctx.actor})`
      gestartet.push(mo.number)
    } catch (err) {
      uebersprungen.push(
        `${mo.number} (${(err instanceof Error ? err.message : String(err)).replace(/^error: /, '')})`,
      )
    }
  }

  if (gestartet.length === 0) {
    throw new Error(
      uebersprungen.length > 0
        ? `Kein Auftrag gestartet — übersprungen: ${uebersprungen.join(', ')}.`
        : 'Keiner der ausgewählten Aufträge wurde gefunden.',
    )
  }
  return {
    text:
      `${plural(gestartet.length, 'Fertigungsauftrag', 'Fertigungsaufträge')} gestartet.` +
      (uebersprungen.length > 0 ? ` Übersprungen: ${uebersprungen.join(', ')}.` : ''),
  }
}

export async function verfuegbarkeitPruefen(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const moId = ctx.recordId!
  await sql`select mo_check_availability(${moId})`

  // Ohne Rückmeldung wäre das ein Knopf, der scheinbar nichts tut, wenn kein
  // Bestand zum Reservieren da ist — genau die Sorte Stille, die Misstrauen sät.
  const [stand] = await sql<{ offen: number; gesamt: number }[]>`
    select count(*) filter (where state in ('confirmed', 'waiting'))::int as offen,
           count(*)::int as gesamt
    from stock_moves
    where production_id = ${moId} and state not in ('done', 'cancel')`
  if (!stand || stand.gesamt === 0) return { recordId: moId }
  return {
    recordId: moId,
    text:
      stand.offen === 0
        ? 'Alle Komponenten sind reserviert.'
        : `${stand.gesamt - stand.offen} von ${stand.gesamt} Positionen reserviert — für den Rest fehlt Bestand.`,
  }
}

export async function fertigMelden(
  p: { qty?: number; mengen: Record<string, number>; backorder: boolean; lot?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select mo_produce(${ctx.recordId!}, ${p.qty ?? null}, ${sql.json(p.mengen)},
    ${p.backorder}, ${ctx.actor}, ${p.lot ?? null})`
  // Versand außerhalb von KRNL (2026-10-15): die Nachfrage ans Team Fertigung
  // ist damit beantwortet — sie wird abgehakt, keiner muss sie extra schließen.
  const nachfragen = await fertigungsNachfrageAbhaken(sql, ctx.recordId!, ctx.actor, 'fertig gemeldet')
  return { recordId: ctx.recordId, text: nachfragen.length ? 'Fertig gemeldet — die Nachfrage an die Fertigung ist abgehakt.' : undefined }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_cancel(${ctx.recordId!}, ${ctx.actor})`
  const nachfragen = await fertigungsNachfrageAbhaken(sql, ctx.recordId!, ctx.actor, 'storniert')
  return { recordId: ctx.recordId, text: nachfragen.length ? 'Storniert — die Nachfrage an die Fertigung ist abgehakt; Bestand des Erzeugnisses per Inventur prüfen.' : undefined }
}

// --- Arbeitsgänge am Auftrag ------------------------------------------------

export async function arbeitsgangStarten(
  p: { operation_id: string; employee_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const moId = ctx.recordId!
  await sql`select mo_operation_start(${p.operation_id}, ${ctx.actor})`
  await sql`update mo_operations set user_id = ${ctx.userId ?? null} where id = ${p.operation_id}`
  await sql`select mo_start(${moId}, ${ctx.actor})`
  // Mit Mitarbeiter läuft zusätzlich die Zeiterfassung — dann zählt beim
  // Abschluss der Personalkostensatz statt des Arbeitsplatzsatzes.
  if (p.employee_id) {
    await sql`select time_entry_start(${p.employee_id}, 'production', ${p.operation_id}, ${ctx.actor})`
  }
  return { recordId: moId }
}

export async function arbeitsgangBeenden(
  p: { operation_id: string; minutes?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Ein zweiter Klick auf einen erledigten Arbeitsgang soll nicht stumm
  // verpuffen — sagen, dass es nichts zu tun gibt.
  const [vorher] = await sql<{ state: string }[]>`
    select state from mo_operations where id = ${p.operation_id}`
  if (vorher?.state === 'done') {
    return { recordId: ctx.recordId, text: 'Dieser Arbeitsgang war bereits abgeschlossen.' }
  }
  await sql`select mo_operation_finish(${p.operation_id}, ${p.minutes ?? null}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

// --- Demontage --------------------------------------------------------------

export async function demontageAnlegen(
  p: { variant_id: string; qty: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [bom] = await sql<{ resolve_bom: string | null }[]>`select resolve_bom(${p.variant_id})`
  if (!bom.resolve_bom) throw new Error('Für dieses Produkt existiert keine Stückliste')

  const [stock] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  const [row] = await sql<{ id: string }[]>`
    insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
    values (next_sequence('unbuild'), ${p.variant_id}, ${bom.resolve_bom}, ${p.qty},
            ${stock.id}, ${stock.id})
    returning id`

  await sql`select log_event('unbuild_order', ${row.id}, 'state', 'Demontageauftrag angelegt', ${ctx.actor})`
  return { text: 'Demontageauftrag angelegt.', recordId: row.id }
}

export async function demontageBuchen(
  p: { force: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select unbuild_apply(${ctx.recordId!}, ${p.force}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

// --- Stücklisten ------------------------------------------------------------

export async function stuecklisteAnlegen(p: {
  template_id: string
  qty: number
}): Promise<AktionsErgebnis> {
  const [tpl] = await sql<{ uom_id: string }[]>`
    select uom_id from product_templates where id = ${p.template_id}`
  if (!tpl) throw new Error('Produkt nicht gefunden')

  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${p.template_id}, ${p.qty}, ${tpl.uom_id})
    returning id`
  return {
    text: 'Stückliste angelegt.',
    link: `/fertigung/stuecklisten/${bom.id}`,
    recordId: bom.id,
  }
}

/**
 * Stückliste auf ein anderes Produkt kopieren (Entscheidungslog 2026-11-23).
 * Die vier 1800er-Stücklisten teilen sich fast alles — statt viermal Zeile
 * für Zeile: eine bauen, kopieren, die Unterschiede ändern.
 *
 * Die Variantenfilter hängen an den Attributwerten des JEWEILIGEN Produkts
 * (product_template_attribute_values); sie werden über Attribut + Wert
 * umgehängt — erst über denselben Wert, sonst über gleiche Namen. Was am
 * Zielprodukt fehlt, wird nicht stillschweigend zu „gilt für alle": ein
 * fehlender Wert entfällt, eine Position ohne übrige Zuordnung wird nicht
 * übernommen und in der Meldung genannt.
 */
export async function stuecklisteKopieren(
  p: { template_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [quelle] = await sql<
    {
      id: string; template_id: string; produkt: string; qty: number; uom_id: string; bom_type: string
      consumption: string; produce_delay: number; days_to_prepare_mo: number
    }[]
  >`
    select b.id, b.template_id, pt.name as produkt, b.qty, b.uom_id, b.bom_type::text as bom_type,
           b.consumption::text as consumption, b.produce_delay, b.days_to_prepare_mo
    from boms b join product_templates pt on pt.id = b.template_id
    where b.id = ${ctx.recordId!}`
  if (!quelle) throw new Error('Stückliste nicht gefunden')

  const [ziel] = await sql<{ id: string; name: string; route_manufacture: boolean; route_mto: boolean; hat: boolean }[]>`
    select pt.id, pt.name, pt.route_manufacture, pt.route_mto,
           exists (select 1 from boms b where b.template_id = pt.id and b.active and b.variant_id is null) as hat
    from product_templates pt where pt.id = ${p.template_id} and pt.active`
  if (!ziel) throw new Error('Zielprodukt nicht gefunden oder nicht aktiv')
  if (ziel.id === quelle.template_id) throw new Error('Quelle und Ziel sind dasselbe Produkt')
  if (ziel.hat) {
    throw new Error(`„${ziel.name}" hat schon eine aktive Stückliste — dort weiterarbeiten statt eine zweite anzulegen`)
  }

  const ergebnis = await tx(async (t) => {
    // Attributwert der Quelle → Attributwert des Ziels (gleicher Wert, sonst gleicher Name).
    const zuordnung = await t<{ quelle_ptav: string; ziel_ptav: string | null; bezeichnung: string }[]>`
      select q.id as quelle_ptav, z.id as ziel_ptav, qa.name || ': ' || qv.name as bezeichnung
      from product_template_attribute_values q
      join product_template_attribute_lines ql on ql.id = q.line_id and ql.template_id = ${quelle.template_id}
      join product_attributes qa on qa.id = ql.attribute_id
      join product_attribute_values qv on qv.id = q.value_id
      left join lateral (
        select zp.id
        from product_template_attribute_values zp
        join product_template_attribute_lines zl on zl.id = zp.line_id and zl.template_id = ${ziel.id}
        join product_attributes za on za.id = zl.attribute_id
        join product_attribute_values zv on zv.id = zp.value_id
        where zp.value_id = q.value_id
           or (lower(za.name) = lower(qa.name) and lower(zv.name) = lower(qv.name))
        order by (zp.value_id = q.value_id) desc
        limit 1) z on true`
    const ptav = new Map(zuordnung.map((z) => [z.quelle_ptav, z]))

    const [neu] = await t<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id, bom_type, consumption, produce_delay, days_to_prepare_mo, note)
      values (${ziel.id}, ${quelle.qty}, ${quelle.uom_id}, ${quelle.bom_type}::bom_type,
              ${quelle.consumption}::consumption_rule, ${quelle.produce_delay}, ${quelle.days_to_prepare_mo},
              ${`Kopie der Stückliste von ${quelle.produkt}`})
      returning id`

    const zeilen = await t<
      { id: string; sequence: number; component_variant_id: string; komponente: string; qty: number; uom_id: string
        issue_method: string; note: string | null; filter: string[] }[]
    >`
      select bl.id, bl.sequence, bl.component_variant_id, variant_display_name(bl.component_variant_id) as komponente,
             bl.qty, bl.uom_id, bl.issue_method::text as issue_method, bl.note,
             array(select f.ptav_id from bom_line_variant_filters f where f.bom_line_id = bl.id) as filter
      from bom_lines bl where bl.bom_id = ${quelle.id}
      order by bl.sequence, bl.created_at`

    let uebernommen = 0
    const ausgelassen: string[] = []
    const gekuerzt: string[] = []
    for (const z of zeilen) {
      const ziele = z.filter.map((f) => ptav.get(f)?.ziel_ptav).filter((x): x is string => Boolean(x))
      const fehlend = z.filter.filter((f) => !ptav.get(f)?.ziel_ptav).map((f) => ptav.get(f)?.bezeichnung ?? '?')
      if (z.filter.length > 0 && ziele.length === 0) {
        ausgelassen.push(`${z.komponente} (${fehlend.join(', ')})`)
        continue
      }
      if (fehlend.length > 0) gekuerzt.push(`${z.komponente} (ohne ${fehlend.join(', ')})`)
      const [zeile] = await t<{ id: string }[]>`
        insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method, manual_consumption, note)
        values (${neu.id}, ${z.sequence}, ${z.component_variant_id}, ${z.qty}, ${z.uom_id},
                ${z.issue_method}::component_issue_method, ${z.issue_method === 'manual'}, ${z.note})
        returning id`
      for (const f of new Set(ziele)) {
        await t`insert into bom_line_variant_filters (bom_line_id, ptav_id) values (${zeile.id}, ${f})`
      }
      uebernommen++
    }

    const gaenge = await t`
      insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes, setup_minutes, note)
      select ${neu.id}, sequence, name, work_center_id, duration_minutes, setup_minutes, note
      from bom_operations where bom_id = ${quelle.id}
      returning id`
    await t`
      insert into bom_byproducts (bom_id, variant_id, qty, uom_id, cost_share)
      select ${neu.id}, variant_id, qty, uom_id, cost_share from bom_byproducts where bom_id = ${quelle.id}`

    await t`select log_event('product_template', ${ziel.id}, 'note',
      ${`Stückliste von ${quelle.produkt} kopiert: ${plural(uebernommen, 'Position', 'Positionen')}` +
        (ausgelassen.length ? `, ${ausgelassen.length} nicht übernommen` : '')}, ${ctx.actor})`
    return { id: neu.id, uebernommen, gaenge: gaenge.length, ausgelassen, gekuerzt }
  })

  const kurz = (liste: string[]) => liste.slice(0, 6).join('; ') + (liste.length > 6 ? ` … und ${liste.length - 6} weitere` : '')
  const teile = [
    `Stückliste auf „${ziel.name}" kopiert: ${plural(ergebnis.uebernommen, 'Position', 'Positionen')}` +
      (ergebnis.gaenge ? `, ${plural(ergebnis.gaenge, 'Arbeitsgang', 'Arbeitsgänge')}` : '') + '.',
    ergebnis.ausgelassen.length
      ? `Nicht übernommen, weil die Zuordnung am Zielprodukt fehlt: ${kurz(ergebnis.ausgelassen)}.`
      : null,
    ergebnis.gekuerzt.length ? `Zuordnung gekürzt: ${kurz(ergebnis.gekuerzt)}.` : null,
    !ziel.route_manufacture || !ziel.route_mto
      ? `Achtung: Am Produkt fehlt ${[!ziel.route_manufacture ? '„Fertigen"' : null, !ziel.route_mto ? '„Auf Bestellung"' : null].filter(Boolean).join(' und ')} — ohne beides entsteht bei einer Bestellung kein Fertigungsauftrag.`
      : null,
  ].filter(Boolean)
  return { text: teile.join(' '), link: `/fertigung/stuecklisten/${ergebnis.id}`, recordId: ergebnis.id }
}

export async function stuecklistePositionHinzufuegen(
  p: {
    component_variant_id: string
    qty: number
    issue_method: 'backflush' | 'manual'
    ptav_ids: string[]
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const bomId = ctx.recordId!
  const [info] = await sql<{ uom_id: string }[]>`
    select pt.uom_id from product_variants pv
    join product_templates pt on pt.id = pv.template_id where pv.id = ${p.component_variant_id}`
  if (!info) throw new Error('Komponente nicht gefunden')

  const [line] = await sql<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_lines where bom_id = ${bomId}), 10),
            ${p.component_variant_id}, ${p.qty}, ${info.uom_id},
            ${p.issue_method}::component_issue_method)
    returning id`

  // "Auf Varianten anwenden": ausgewählte Attributwerte übernehmen.
  for (const ptavId of p.ptav_ids) {
    await sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
              values (${line.id}, ${ptavId}) on conflict do nothing`
  }

  return { recordId: bomId }
}

/**
 * Position ändern (A3): Menge, Zuordnung („gilt nur für …") und wahlweise
 * die Komponente — in einer Transaktion, damit nie eine Position ohne ihre
 * Zuordnung dasteht (sie gälte dann für alle Varianten).
 */
export async function stuecklistePositionAendern(
  p: { line_id: string; qty: number; ptav_ids: string[]; component_variant_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const bomId = ctx.recordId!
  const text = await tx(async (t) => {
    const [zeile] = await t<{ id: string; component_variant_id: string; template_id: string; name: string }[]>`
      select l.id, l.component_variant_id, b.template_id, variant_display_name(l.component_variant_id) as name
      from bom_lines l join boms b on b.id = l.bom_id
      where l.id = ${p.line_id} and l.bom_id = ${bomId} for update of l`
    if (!zeile) throw new Error('Position nicht gefunden')

    // Zuordnungen müssen zu DIESEM Produkt gehören — sonst träfe der Filter nie.
    if (p.ptav_ids.length > 0) {
      const [{ n }] = await t<{ n: number }[]>`
        select count(*)::int as n from product_template_attribute_values ptav
        join product_template_attribute_lines al on al.id = ptav.line_id
        where ptav.id = any(${p.ptav_ids}::uuid[]) and al.template_id = ${zeile.template_id}`
      if (Number(n) !== new Set(p.ptav_ids).size) throw new Error('Eine Zuordnung gehört nicht zu diesem Produkt')
    }

    let name = zeile.name
    if (p.component_variant_id && p.component_variant_id !== zeile.component_variant_id) {
      const [neu] = await t<{ uom_id: string; template_id: string; name: string }[]>`
        select pt.uom_id, pv.template_id, variant_display_name(pv.id) as name
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${p.component_variant_id}`
      if (!neu) throw new Error('Komponente nicht gefunden')
      if (neu.template_id === zeile.template_id) throw new Error('Ein Produkt kann nicht Komponente seiner selbst sein')
      await t`update bom_lines set component_variant_id = ${p.component_variant_id}, uom_id = ${neu.uom_id}
              where id = ${p.line_id}`
      name = neu.name
    }
    await t`update bom_lines set qty = ${p.qty} where id = ${p.line_id}`
    await t`delete from bom_line_variant_filters where bom_line_id = ${p.line_id}`
    for (const ptavId of new Set(p.ptav_ids)) {
      await t`insert into bom_line_variant_filters (bom_line_id, ptav_id) values (${p.line_id}, ${ptavId})`
    }
    await t`select log_event('product_template', ${zeile.template_id}, 'note',
      ${`Stückliste: ${name} geändert — Menge ${p.qty}, ${p.ptav_ids.length ? `gilt für ${plural(p.ptav_ids.length, 'Optionswert', 'Optionswerte')}` : 'gilt für alle Varianten'}`},
      ${ctx.actor})`
    return `${name}: Menge ${p.qty}, ${p.ptav_ids.length ? 'Zuordnung gesetzt' : 'gilt für alle Varianten'}.`
  })
  return { recordId: bomId, text }
}

export async function stuecklistePositionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from bom_lines where id = ${p.line_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function stuecklisteVerbrauch(
  p: { consumption: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update boms set consumption = ${p.consumption}::consumption_rule
            where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function stuecklisteVerbrauchsart(
  p: { line_id: string; method: 'backflush' | 'manual' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update bom_lines
       set issue_method = ${p.method}::component_issue_method,
           manual_consumption = ${p.method === 'manual'}
     where id = ${p.line_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function auftragDetails(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Abgeschlossene Aufträge bleiben, wie sie sind (F6).
  const [mo] = await sql<{ state: string; number: string }[]>`
    select state::text as state, number from manufacturing_orders where id = ${ctx.recordId!}`
  if (!mo) throw new Error('Fertigungsauftrag nicht gefunden.')
  schreibschutzPruefen('mo', mo.state, mo.number)
  await sql`
    update manufacturing_orders set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

// --- Arbeitsplätze + Arbeitsgänge an der Stückliste --------------------------

export async function arbeitsplatzAnlegen(p: {
  code: string
  name: string
  art: string
  cost_per_hour: number
  capacity: number
  time_efficiency: number
  note?: string
}): Promise<AktionsErgebnis> {
  // Uppercase auch hier, nicht nur im Formular-Adapter — die KI liefert
  // Kürzel in beliebiger Schreibweise.
  const code = p.code.toUpperCase()
  await sql`
    insert into work_centers (code, name, art, cost_per_hour, capacity, time_efficiency, note)
    values (${code}, ${p.name}, ${p.art}, ${p.cost_per_hour}, ${p.capacity}, ${p.time_efficiency},
            ${p.note ?? null})`
  return { text: `Arbeitsplatz ${code} angelegt.` }
}

export async function arbeitsplatzAendern(
  p: {
    name: string
    art?: string
    cost_per_hour: number
    capacity: number
    time_efficiency: number
    active: boolean
    note?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update work_centers set
      name = ${p.name},
      art = coalesce(${p.art ?? null}, art),
      cost_per_hour = ${p.cost_per_hour},
      capacity = ${p.capacity},
      time_efficiency = ${p.time_efficiency},
      active = ${p.active},
      note = ${p.note ?? null}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function arbeitsgangHinzufuegen(
  p: { name: string; work_center_id: string; duration_minutes: number; setup_minutes: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const bomId = ctx.recordId!
  await sql`
    insert into bom_operations (bom_id, sequence, name, work_center_id,
                                duration_minutes, setup_minutes)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_operations where bom_id = ${bomId}), 10),
            ${p.name}, ${p.work_center_id}, ${p.duration_minutes}, ${p.setup_minutes})`
  return { recordId: bomId }
}

export async function arbeitsgangEntfernen(
  p: { operation_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from bom_operations where id = ${p.operation_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}
