/**
 * Lese-/Schreibmodus der Shopify-Anbindung: Standard und Umschaltung
 * (settings.shopify) sowie die Mutations-Erkennung, an der der Wächter in
 * shopifyGraphQL() hängt. Der Wächter selbst läuft im Prozesstest
 * tests/prozesse/shopify-modus.test.ts durch die echte Naht.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, withRollback } from './helpers.ts'
import { imProbelaufErlaubt, istMutation, shopifyModus } from '../src/modules/integrationen/shopify-modus.ts'

describe('Shopify-Modus: Ausnahme im Probelauf', () => {
  const anlegen = `mutation anlegen($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`
  const umziehen = `mutation aktualisieren($id: ID!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) { userErrors { message } } }`

  test('Webhook-Abos anlegen und umziehen gehen im Probelauf hinaus', () => {
    assert.equal(imProbelaufErlaubt(anlegen), true)
    assert.equal(imProbelaufErlaubt(umziehen), true)
  })

  test('alles andere bleibt gesperrt — auch im Windschatten eines Webhook-Abos', () => {
    assert.equal(imProbelaufErlaubt('mutation m($i: [InventorySetQuantityInput!]!) { inventorySetQuantities(input: $i) { userErrors { message } } }'), false)
    assert.equal(imProbelaufErlaubt('mutation l($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }'), false)
    assert.equal(imProbelaufErlaubt('query { webhookSubscriptions(first: 5) { nodes { id } } }'), false)
    assert.equal(
      imProbelaufErlaubt(`mutation m($t: WebhookSubscriptionTopic!, $s: WebhookSubscriptionInput!, $p: ProductInput!) {
        webhookSubscriptionCreate(topic: $t, webhookSubscription: $s) { userErrors { message } }
        productUpdate(input: $p) { userErrors { message } } }`),
      false,
    )
  })
})

describe('Shopify-Modus: Einstellung', () => {
  test('ohne Eintrag gilt „lesen" — Zugangsdaten allein schalten nichts scharf', async () => {
    await withRollback(async (t) => {
      await t`delete from settings where key = 'shopify'`
      assert.equal(await shopifyModus(t), 'lesen')
    })
  })

  test('„schreiben" nur bei genau diesem Wert, alles andere bleibt lesen', async () => {
    await withRollback(async (t) => {
      await t`insert into settings (key, value) values ('shopify', '{"modus":"schreiben"}')
              on conflict (key) do update set value = excluded.value`
      assert.equal(await shopifyModus(t), 'schreiben')
      await t`update settings set value = '{"modus":"Schreiben"}' where key = 'shopify'`
      assert.equal(await shopifyModus(t), 'lesen', 'Tippfehler fällt auf die sichere Seite')
      await t`update settings set value = '{}' where key = 'shopify'`
      assert.equal(await shopifyModus(t), 'lesen')
    })
  })
})

describe('Shopify-Modus: Mutations-Erkennung', () => {
  test('Mutationen werden erkannt, Queries und anonyme Dokumente nicht', () => {
    assert.ok(istMutation('mutation anlegen($topic: X) { webhookSubscriptionCreate { id } }'))
    assert.ok(istMutation('\n  mutation { orderCancel { job { id } } }'))
    assert.ok(istMutation('# Bestand melden\nmutation bestand($input: I) { inventorySetQuantities { x } }'))
    assert.ok(!istMutation('query mutationen { shop { name } }'), 'Feldname „mutationen" ist keine Mutation')
    assert.ok(!istMutation('{ shop { name } }'), 'anonymes Dokument = Query')
    assert.ok(!istMutation('query { orders(first: 1) { edges { node { id } } } }'))
  })
})

after(closeDb)
