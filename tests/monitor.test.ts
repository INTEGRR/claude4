import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, expectError, withRollback } from './helpers.ts'

after(closeDb)

describe('Ereignis-Monitor', () => {
  test('api_transactions nimmt Erfolge und Fehler auf', async () => {
    await withRollback(async (t) => {
      await t`insert into api_transactions (system, kind, reference, ok, status_code, duration_ms)
              values ('dhl', 'label_create', 'WH/OUT/00001', true, 200, 412)`
      await t`insert into api_transactions (system, kind, ok, error)
              values ('shopify', 'graphql:order', false, 'THROTTLED')`

      const [fehler] = await t<{ count: number }[]>`
        select count(*)::int as count from api_transactions where not ok`
      assert.equal(fehler.count, 1)
    })
  })

  test('api_transactions erlaubt nur bekannte Systeme', async () => {
    await withRollback(async (t) => {
      await expectError(
        t,
        (sp) => sp`insert into api_transactions (system, kind, ok) values ('fax', 'senden', true)`,
        /check/i,
      )
    })
  })

  test('reap_stuck_jobs holt hängengebliebene Läufe zurück', async () => {
    await withRollback(async (t) => {
      const [haengt] = await t<{ id: string }[]>`
        insert into integration_jobs (kind, status, started_at)
        values ('shopify_tag_add', 'running', now() - interval '25 minutes') returning id`
      const [frisch] = await t<{ id: string }[]>`
        insert into integration_jobs (kind, status, started_at)
        values ('shopify_tag_add', 'running', now() - interval '2 minutes') returning id`

      const [reaped] = await t<{ reap_stuck_jobs: number }[]>`select reap_stuck_jobs(10)`
      assert.equal(Number(reaped.reap_stuck_jobs), 1, 'nur der alte Lauf wird zurückgeholt')

      const [a] = await t<{ status: string }[]>`
        select status from integration_jobs where id = ${haengt.id}`
      assert.equal(a.status, 'pending')
      const [b] = await t<{ status: string }[]>`
        select status from integration_jobs where id = ${frisch.id}`
      assert.equal(b.status, 'running', 'laufender Job bleibt unangetastet')
    })
  })

  test('prune_monitor_data räumt Altes auf und verschont Offenes', async () => {
    await withRollback(async (t) => {
      // Alt und erledigt → weg
      await t`insert into api_transactions (system, kind, ok, created_at)
              values ('mail', 'send', true, now() - interval '31 days')`
      await t`insert into integration_jobs (kind, status, created_at)
              values ('send_po_email', 'done', now() - interval '61 days')`
      const [altEvent] = await t<{ id: string }[]>`
        insert into shopify_webhook_events (webhook_id, topic, payload, status, received_at)
        values ('wh-alt', 'orders/create', '{}', 'done', now() - interval '61 days') returning id`
      // Alt, aber mit offener Zuordnung → bleibt
      const [mitOffen] = await t<{ id: string }[]>`
        insert into shopify_webhook_events (webhook_id, topic, payload, status, received_at)
        values ('wh-offen', 'orders/create', '{}', 'done', now() - interval '61 days') returning id`
      await t`insert into shopify_unmatched_lines (event_id, shopify_order_id, sku)
              values (${mitOffen.id}, 'gid://shopify/Order/1', 'UNBEKANNT')`
      // Frisch → bleibt
      await t`insert into api_transactions (system, kind, ok) values ('mail', 'send', true)`

      const [result] = await t<{ prune_monitor_data: Record<string, number> }[]>`
        select prune_monitor_data()`
      assert.equal(result.prune_monitor_data.transaktionen, 1)
      assert.equal(result.prune_monitor_data.jobs, 1)
      assert.equal(result.prune_monitor_data.webhooks, 1)

      const [alt] = await t<{ count: number }[]>`
        select count(*)::int as count from shopify_webhook_events where id = ${altEvent.id}`
      assert.equal(alt.count, 0, 'altes erledigtes Event ist weg')
      const [offen] = await t<{ count: number }[]>`
        select count(*)::int as count from shopify_webhook_events where id = ${mitOffen.id}`
      assert.equal(offen.count, 1, 'Event mit offener Zuordnung bleibt')
    })
  })

  test('Webhook-Backoff: next_attempt_at steuert die Fälligkeit', async () => {
    await withRollback(async (t) => {
      await t`insert into shopify_webhook_events (webhook_id, topic, payload, status, next_attempt_at)
              values ('wh-warte', 'orders/create', '{}', 'pending', now() + interval '5 minutes')`
      await t`insert into shopify_webhook_events (webhook_id, topic, payload, status)
              values ('wh-jetzt', 'orders/create', '{}', 'pending')`

      // Dieselbe Fälligkeitsbedingung wie in processPendingWebhooks.
      const due = await t<{ webhook_id: string }[]>`
        select webhook_id from shopify_webhook_events
        where status = 'pending' and attempts < 5 and next_attempt_at <= now()`
      const ids = due.map((d) => d.webhook_id)
      assert.ok(ids.includes('wh-jetzt'))
      assert.ok(!ids.includes('wh-warte'), 'zurückgestelltes Event ist nicht fällig')
    })
  })
})
