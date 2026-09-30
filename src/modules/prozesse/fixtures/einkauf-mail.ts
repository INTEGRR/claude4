import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Mail an Lieferanten end-to-end (0094) mit Gmail-/Drive-Attrappe und
 * KI_FAKE: Preisanfrage aus der Vorlage an einen chinesischen Lieferanten
 * (Deutsch zum Mitlesen, Chinesisch wird gesendet) → freigeben → Dienst
 * gmail_senden. Danach steht die Mail als Nachricht im neuen Thread, der
 * Entwurf ist `gesendet`, „Antwort erwartet bis" hat eine Wiedervorlage
 * erzeugt. Zweiter Lauf: Entwurf verwerfen.
 */
export const EINKAUF_MAIL: ProzessFixture = {
  prozess: 'mail_versand',
  benoetigt: ['basis'],
  aufbauen: async (sql, ctx) => {
    const [p] = await sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company, email, sprache, country_code, mail_domains)
      values ('Shenzhen Mailtest Co.', true, true, 'sales@mailtest.cn', 'zh', 'CN', '{mailtest.cn}')
      returning id`
    ctx.mailLieferantId = p.id
  },
  laeufe: [
    {
      name: 'Preisanfrage auf Chinesisch aus der Vorlage, freigeben, im Postfach gesendet',
      pfad: ['anlegen', 'freigeben', 'senden'],
      eingaben: {
        anlegen: (ctx) => ({ partner_id: ctx.mailLieferantId, vorlage: 'anfrage', antwort_erwartet_bis: '2026-10-14' }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx, entwurfId) => {
        const [e] = await sql<{ status: string; sprache: string; an: string[]; betreff: string; text_ziel: string; thread_id: string; nachricht_id: string }[]>`
          select status::text, sprache, an, betreff, text_ziel, thread_id, nachricht_id from mail_entwuerfe where id = ${entwurfId}`
        assert.equal(e.status, 'gesendet')
        assert.equal(e.sprache, 'zh')
        assert.deepEqual(e.an, ['sales@mailtest.cn'])
        assert.match(e.betreff, /^询价/)
        assert.match(e.text_ziel, /最小起订量/)
        const [t] = await sql<{ partner_id: string; letzte_richtung: string; anzahl: number }[]>`
          select partner_id, letzte_richtung::text, anzahl from mail_threads where id = ${e.thread_id}`
        assert.deepEqual(t, { partner_id: ctx.mailLieferantId, letzte_richtung: 'ausgang', anzahl: 1 })
        const [n] = await sql<{ richtung: string; text: string; text_de: string; rfc822_id: string }[]>`
          select richtung::text, text, text_de, rfc822_id from mail_nachrichten where id = ${e.nachricht_id}`
        assert.equal(n.richtung, 'ausgang')
        assert.match(n.text, /最小起订量/)
        assert.match(n.text_de, /Stückpreis je Staffel/)
        assert.match(n.rfc822_id, /^<krnl\./)
        const [w] = await sql<{ faellig_am: string; grund: string }[]>`
          select faellig_am::text, grund from wiedervorlagen where modell = 'mail_thread' and record_id = ${e.thread_id}`
        assert.equal(w.faellig_am, '2026-10-14')
        assert.match(w.grund, /^Antwort erwartet: 询价/)
      },
    },
    {
      name: 'Entwurf verwerfen',
      pfad: ['anlegen', 'verwerfen'],
      eingaben: {
        anlegen: (ctx) => ({ partner_id: ctx.mailLieferantId, betreff: 'Test', text_de: 'Doch nicht.' }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, entwurfId) => {
        const [e] = await sql<{ status: string }[]>`select status::text from mail_entwuerfe where id = ${entwurfId}`
        assert.equal(e.status, 'verworfen')
      },
    },
  ],
}
