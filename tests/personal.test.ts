import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, expectError, makeProduct, stockUp, uomStueck, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Personal: Stammsatz, Stempeluhr, Schichtplan, Abwesenheiten — und die
 * Klammer zur Fertigung: gebuchte Auftragszeit wird zu Lohnkosten.
 */
let counter = 0

async function makeEmployee(
  t: TransactionSql,
  opts: { cost?: number; name?: string; barcode?: string } = {},
) {
  const n = ++counter
  const [row] = await t<{ id: string; number: string }[]>`
    insert into employees (number, name, hourly_cost, barcode)
    values (next_sequence('employee'), ${opts.name ?? `Mitarbeiter ${n}`},
            ${opts.cost ?? 32}, ${opts.barcode ?? `AUSWEIS-${n}`})
    returning id, number`
  return row
}

describe('Mitarbeiter', () => {
  test('Personalnummer und Ausweis sind eindeutig', async () => {
    await withRollback(async (t) => {
      const a = await makeEmployee(t, { barcode: 'AUSWEIS-DOPPELT' })
      assert.match(a.number, /^MA\d{4}$/)

      await expectError(
        t,
        (sp) => sp`
          insert into employees (number, name, barcode)
          values (next_sequence('employee'), 'Zweiter', 'AUSWEIS-DOPPELT')`,
        /employees_barcode_key|duplicate key/i,
      )
    })
  })

  test('das Austrittsdatum darf nicht vor dem Eintritt liegen', async () => {
    await withRollback(async (t) => {
      await expectError(
        t,
        (sp) => sp`
          insert into employees (number, name, hire_date, exit_date)
          values (next_sequence('employee'), 'Rückwärts', '2026-05-01', '2026-01-01')`,
        /employees_check|violates check/i,
      )
    })
  })
})

describe('Stempeluhr', () => {
  test('Anmelden und Abmelden schreiben die Nettodauer fest', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [ein] = await t<{ action: string }[]>`select * from time_clock_toggle(${e.id}, 'test')`
      assert.equal(ein.action, 'in')

      const [anwesend] = await t<{ name: string }[]>`
        select name from employees_present where employee_id = ${e.id}`
      assert.ok(anwesend, 'erscheint in der Anwesenheitsliste')

      // Startzeit zurückdatieren, damit eine messbare Dauer entsteht.
      await t`update time_entries set started_at = now() - interval '4 hours'
              where employee_id = ${e.id} and ended_at is null`

      const [aus] = await t<{ action: string; minutes: number }[]>`
        select * from time_clock_toggle(${e.id}, 'test')`
      assert.equal(aus.action, 'out')
      assert.ok(Number(aus.minutes) > 239 && Number(aus.minutes) < 241, `4 Stunden, war ${aus.minutes}`)

      const [leer] = await t<{ c: number }[]>`
        select count(*)::int as c from employees_present where employee_id = ${e.id}`
      assert.equal(leer.c, 0)
    })
  })

  test('zweimal anmelden geht nicht', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      await t`select time_entry_start(${e.id}, 'attendance', null, 'test')`
      await expectError(
        t,
        (sp) => sp`select time_entry_start(${e.id}, 'attendance', null, 'test')`,
        /bereits angemeldet/,
      )
    })
  })

  test('Pausen werden von der Anwesenheit abgezogen', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [entry] = await t<{ time_entry_start: string }[]>`
        select time_entry_start(${e.id}, 'attendance', null, 'test')`
      await t`update time_entries set started_at = now() - interval '8 hours'
              where id = ${entry.time_entry_start}`

      const [row] = await t<{ time_entry_stop: number }[]>`
        select time_entry_stop(${entry.time_entry_start}, 45, 'test')`
      assert.ok(
        Number(row.time_entry_stop) > 434 && Number(row.time_entry_stop) < 436,
        `480 − 45 Minuten, war ${row.time_entry_stop}`,
      )

      const [summe] = await t<{ employee_minutes: number }[]>`
        select employee_minutes(${e.id}, current_date - 1, current_date)`
      assert.ok(Number(summe.employee_minutes) > 434)
    })
  })

  test('Auftragszeit ohne Arbeitsgang wird abgelehnt', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      await expectError(
        t,
        (sp) => sp`select time_entry_start(${e.id}, 'production', null, 'test')`,
        /muss ein Arbeitsgang/,
      )
    })
  })
})

describe('Schichtplan', () => {
  test('ein Mitarbeiter steht nicht zweimal gleichzeitig im Plan', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [tpl] = await t<{ id: string }[]>`select id from shift_templates where code = 'FRUEH'`

      await t`
        insert into shift_assignments (employee_id, template_id, starts_at, ends_at, state)
        values (${e.id}, ${tpl.id}, '2026-09-07 06:00+02', '2026-09-07 14:00+02', 'published')`

      await expectError(
        t,
        (sp) => sp`
          insert into shift_assignments (employee_id, starts_at, ends_at, state)
          values (${e.id}, '2026-09-07 13:00+02', '2026-09-07 21:00+02', 'published')`,
        /conflicting key value|exclusion constraint/i,
      )

      // Direkt im Anschluss ist dagegen erlaubt.
      await t`
        insert into shift_assignments (employee_id, starts_at, ends_at, state)
        values (${e.id}, '2026-09-07 14:00+02', '2026-09-07 22:00+02', 'published')`
      const [anzahl] = await t<{ c: number }[]>`
        select count(*)::int as c from shift_assignments where employee_id = ${e.id}`
      assert.equal(anzahl.c, 2)
    })
  })

  test('während einer genehmigten Abwesenheit wird nicht geplant', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [abw] = await t<{ id: string }[]>`
        insert into absences (employee_id, kind, starts_on, ends_on)
        values (${e.id}, 'vacation', '2026-09-07', '2026-09-11') returning id`
      await t`select absence_approve(${abw.id}, null, 'test')`

      await expectError(
        t,
        (sp) => sp`
          insert into shift_assignments (employee_id, starts_at, ends_at)
          values (${e.id}, '2026-09-09 06:00+02', '2026-09-09 14:00+02')`,
        /ist im Zeitraum abwesend/,
      )
    })
  })
})

describe('Abwesenheiten', () => {
  test('überschneidende Anträge werden abgewiesen', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      await t`insert into absences (employee_id, kind, starts_on, ends_on)
              values (${e.id}, 'vacation', '2026-07-06', '2026-07-17')`

      await expectError(
        t,
        (sp) => sp`
          insert into absences (employee_id, kind, starts_on, ends_on)
          values (${e.id}, 'sick', '2026-07-17', '2026-07-20')`,
        /conflicting key value|exclusion constraint/i,
      )
    })
  })

  test('ein abgelehnter Antrag gibt den Zeitraum wieder frei', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [erst] = await t<{ id: string }[]>`
        insert into absences (employee_id, kind, starts_on, ends_on)
        values (${e.id}, 'vacation', '2026-07-06', '2026-07-10') returning id`
      await t`select absence_decide(${erst.id}, 'rejected', 'Betrieb zu voll', null, 'test')`

      await t`insert into absences (employee_id, kind, starts_on, ends_on)
              values (${e.id}, 'vacation', '2026-07-06', '2026-07-10')`
      const [offen] = await t<{ c: number }[]>`
        select count(*)::int as c from absences
        where employee_id = ${e.id} and state = 'requested'`
      assert.equal(offen.c, 1)
    })
  })

  test('Arbeitstage zählen ohne Wochenende, halbe Tage zählen halb', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      // Mo 06.07.2026 bis So 12.07.2026 = 5 Arbeitstage
      const [woche] = await t<{ id: string }[]>`
        insert into absences (employee_id, kind, starts_on, ends_on)
        values (${e.id}, 'vacation', '2026-07-06', '2026-07-12') returning id`
      const [tage] = await t<{ absence_days: number }[]>`select absence_days(${woche.id})`
      assert.equal(Number(tage.absence_days), 5)

      const [halb] = await t<{ id: string }[]>`
        insert into absences (employee_id, kind, starts_on, ends_on, half_day)
        values (${e.id}, 'vacation', '2026-08-03', '2026-08-03', true) returning id`
      const [halbTage] = await t<{ absence_days: number }[]>`select absence_days(${halb.id})`
      assert.equal(Number(halbTage.absence_days), 0.5)
    })
  })

  test('nur offene Anträge lassen sich genehmigen', async () => {
    await withRollback(async (t) => {
      const e = await makeEmployee(t)
      const [a] = await t<{ id: string }[]>`
        insert into absences (employee_id, kind, starts_on, ends_on)
        values (${e.id}, 'training', '2026-10-05', '2026-10-06') returning id`
      await t`select absence_approve(${a.id}, null, 'test')`
      await expectError(
        t,
        (sp) => sp`select absence_approve(${a.id}, null, 'test')`,
        /Nur offene Anträge/,
      )
    })
  })
})

describe('Auftragszeit und Herstellkosten', () => {
  /** Kleines Fertigungsszenario mit einem Arbeitsgang. */
  async function moMitArbeitsgang(t: TransactionSql, wcRate: number) {
    const uom = await uomStueck(t)
    const n = ++counter
    const teil = await makeProduct(t, `Zeit-Teil ${n}`)
    await t`update product_templates set standard_cost = 10
            where id = (select template_id from product_variants where id = ${teil})`
    await stockUp(t, teil, 50)
    await t`select valuation_initialize(${teil}, 'test')`

    const fertig = await makeProduct(t, `Zeit-Produkt ${n}`)
    const [bom] = await t<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id)
      select template_id, 1, ${uom} from product_variants where id = ${fertig} returning id`
    await t`insert into bom_lines (bom_id, component_variant_id, qty, uom_id)
            values (${bom.id}, ${teil}, 1, ${uom})`

    const [wc] = await t<{ id: string }[]>`
      insert into work_centers (code, name, cost_per_hour)
      values (${`WCZ${n}`}, ${`Platz ${n}`}, ${wcRate}) returning id`
    await t`insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes)
            values (${bom.id}, 10, 'Montage', ${wc.id}, 60)`

    const [mo] = await t<{ create_manufacturing_order: string }[]>`
      select create_manufacturing_order(${fertig}, 1)`
    await t`select mo_confirm(${mo.create_manufacturing_order}, 'test')`
    const [op] = await t<{ id: string }[]>`
      select id from mo_operations where mo_id = ${mo.create_manufacturing_order}`
    return { moId: mo.create_manufacturing_order, opId: op.id, fertig }
  }

  test('gebuchte Zeit zählt zum Personalkostensatz, nicht zum Platzsatz', async () => {
    await withRollback(async (t) => {
      const s = await moMitArbeitsgang(t, 100) // Arbeitsplatz absichtlich teuer
      const e = await makeEmployee(t, { cost: 40 })

      const [entry] = await t<{ time_entry_start: string }[]>`
        select time_entry_start(${e.id}, 'production', ${s.opId}, 'test')`
      await t`update time_entries set started_at = now() - interval '30 minutes'
              where id = ${entry.time_entry_start}`
      await t`select time_entry_stop(${entry.time_entry_start}, null, 'test')`

      const [op] = await t<{ duration_real: number }[]>`
        select duration_real from mo_operations where id = ${s.opId}`
      assert.ok(Number(op.duration_real) > 29 && Number(op.duration_real) < 31)

      await t`select mo_operation_finish(${s.opId}, null, 'test')`
      const [nachher] = await t<{ duration_real: number }[]>`
        select duration_real from mo_operations where id = ${s.opId}`
      assert.ok(
        Number(nachher.duration_real) < 31,
        `die Zeit wird nicht doppelt gezählt, war ${nachher.duration_real}`,
      )

      const [kosten] = await t<{ mo_labor_cost: number }[]>`select mo_labor_cost(${s.moId})`
      assert.ok(
        Math.abs(Number(kosten.mo_labor_cost) - 20) < 0.5,
        `30 Min. zu 40 €/h = 20 €, war ${kosten.mo_labor_cost}`,
      )
    })
  })

  test('ohne Zeiterfassung bleibt der Stundensatz des Arbeitsplatzes maßgeblich', async () => {
    await withRollback(async (t) => {
      const s = await moMitArbeitsgang(t, 60)
      await t`select mo_operation_finish(${s.opId}, 30, 'test')`
      const [kosten] = await t<{ mo_labor_cost: number }[]>`select mo_labor_cost(${s.moId})`
      assert.equal(Number(kosten.mo_labor_cost), 30, '30 Min. zu 60 €/h')
    })
  })

  test('die Fertigmeldung stempelt eine offene Auftragszeit mit ab', async () => {
    await withRollback(async (t) => {
      const s = await moMitArbeitsgang(t, 0)
      const e = await makeEmployee(t, { cost: 60 })
      const [entry] = await t<{ time_entry_start: string }[]>`
        select time_entry_start(${e.id}, 'production', ${s.opId}, 'test')`
      await t`update time_entries set started_at = now() - interval '20 minutes'
              where id = ${entry.time_entry_start}`

      await t`select mo_produce(${s.moId}, 1, '{}'::jsonb, true, 'test')`

      const [offen] = await t<{ c: number }[]>`
        select count(*)::int as c from time_entries
        where id = ${entry.time_entry_start} and ended_at is null`
      assert.equal(offen.c, 0, 'kein Eintrag bleibt offen stehen')

      const [row] = await t<{ labor_cost: number; unit_cost: number }[]>`
        select labor_cost, unit_cost from manufacturing_orders where id = ${s.moId}`
      assert.ok(
        Math.abs(Number(row.labor_cost) - 20) < 0.5,
        `20 Min. zu 60 €/h = 20 €, war ${row.labor_cost}`,
      )
      assert.ok(
        Math.abs(Number(row.unit_cost) - 30) < 0.5,
        `10 € Material + 20 € Lohn, war ${row.unit_cost}`,
      )
    })
  })
})
