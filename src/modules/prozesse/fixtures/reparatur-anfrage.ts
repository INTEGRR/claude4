import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Reparaturanfrage — der Laufzeit-Prozess auf Vorgängen, den das öffentliche
 * Kundenformular anstößt. Beweist die Kette: Anfrage (zusatz-Felder) →
 * Annehmen → Kunde per E-Mail wiederverwendet/angelegt → Reparaturauftrag
 * mit Herkunft → Retourenlabel mit der RMA-Nummer als Referenz → Auftrag
 * wartet auf das Gerät. Die Anfrage selbst wird hier über die Registry
 * angelegt (wie eine telefonische); die öffentliche Route hat ihren eigenen
 * Test (tests/reparatur-anfrage.test.ts).
 */
const ANFRAGE = {
  kontakt_name: 'Erika Musterfrau',
  email: 'anfrage@example.com',
  telefon: '+49 30 1234567',
  strasse: 'Prozessweg',
  hausnummer: '7',
  plz: '10115',
  ort: 'Berlin',
  land: 'DE',
  fehlerbeschreibung: 'Die Leertaste prellt seit ein paar Tagen — jeder zweite Anschlag doppelt.',
  bestellnummer: '#1042',
}

export const REPARATUR_ANFRAGE: ProzessFixture = {
  prozess: 'reparatur_anfrage',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'annehmen: Kunde, Reparaturauftrag mit Herkunft, Retourenlabel mit RMA-Referenz',
      pfad: ['anlegen', 'annehmen'],
      eingaben: {
        // prozess_code kommt aus den Schritt-params der Definition.
        anlegen: { titel: 'Reparaturanfrage Erika Musterfrau', zusatz: ANFRAGE },
        // state kommt aus den Schritt-params; das Produkt wählt der Mitarbeiter.
        annehmen: (ctx) => ({
          variant_id: ctx.geraetId,
          under_warranty: false,
          qty: 1,
          label_senden: true,
        }),
      },
      pruefen: async (sql, _ctx, vorgangId) => {
        const [v] = await sql<{ number: string; state: string; partner_id: string | null }[]>`
          select number, state, partner_id from vorgaenge where id = ${vorgangId}`
        assert.equal(v.state, 'angenommen')
        assert.ok(v.partner_id, 'der Vorgang trägt jetzt den Kunden')

        const [kunde] = await sql<{ email: string | null; street: string | null; is_customer: boolean }[]>`
          select email, street, is_customer from partners where id = ${v.partner_id}`
        assert.equal(kunde.email, ANFRAGE.email, 'Kunde aus den Kontaktdaten der Anfrage')
        assert.equal(kunde.street, ANFRAGE.strasse)
        assert.equal(kunde.is_customer, true)

        // Der Reparaturauftrag hängt über origin an der Anfrage und wartet
        // auf das Gerät — das Retourenlabel ist raus.
        const [auftrag] = await sql<
          { id: string; number: string; state: string; origin_label: string | null; note: string | null }[]
        >`
          select id, number, state, origin_label, note from repair_orders
          where origin_model = 'vorgang' and origin_id = ${vorgangId}`
        assert.ok(auftrag, 'der Reparaturauftrag muss über origin an der Anfrage hängen')
        assert.match(auftrag.number, /^RMA\//)
        assert.equal(auftrag.state, 'awaiting_device')
        assert.equal(auftrag.origin_label, v.number)
        assert.match(auftrag.note ?? '', /Leertaste/, 'die Fehlerbeschreibung wird zur Notiz')
        assert.match(auftrag.note ?? '', /#1042/, 'die Bestellnummer steht dabei')

        const [label] = await sql<{ shipment_number: string | null }[]>`
          select shipment_number from return_labels where repair_order_id = ${auftrag.id}`
        assert.ok(label, 'das Retourenlabel hängt am Reparaturauftrag')
        assert.match(label.shipment_number ?? '', /^\d{20}$/)

        // DHL bekam die RMA-Nummer als Kundenreferenz (der Fake protokolliert sie).
        const [dhl] = await sql<{ reference: string | null }[]>`
          select reference from api_transactions
          where system = 'dhl' and kind = 'fake:return_label'
          order by created_at desc limit 1`
        assert.equal(dhl?.reference, auftrag.number, 'Retourenlabel trägt die RMA-Nummer als Referenz')

        // Die Mail liegt in der Outbox (der Kunde hat eine E-Mail-Adresse).
        const [job] = await sql<{ status: string }[]>`
          select status from integration_jobs
          where kind = 'send_return_label_email' and payload ->> 'return_label_id' is not null
          order by created_at desc limit 1`
        assert.ok(job, 'die Retourenlabel-Mail ist eingereiht')

        // Teilprozess-Verkettung: der Anfrage-Prozess sieht den Auftrag als Kindbeleg.
        const [stand] = await sql<{ gesamt: number; fertig: number }[]>`
          select gesamt, fertig from teilprozess_stand('reparatur', null, 'vorgang', ${vorgangId})`
        assert.equal(Number(stand.gesamt), 1, 'teilprozess_stand findet den Reparaturauftrag')
        assert.equal(Number(stand.fertig), 0, 'die Reparatur steht noch aus')

        // Höchstens EIN Auftrag je Anfrage — der partielle Unique-Index hält.
        await assert.rejects(
          sql`insert into repair_orders (number, partner_id, variant_id, origin_model, origin_id)
              select next_sequence('repair'), partner_id, variant_id, 'vorgang', ${vorgangId}
              from repair_orders where id = ${auftrag.id}`,
          /duplicate key|ein_auftrag_je_vorgang/,
        )
      },
    },
    {
      name: 'bekannter Kunde: dieselbe E-Mail führt zum bestehenden Kontakt',
      pfad: ['anlegen', 'annehmen'],
      eingaben: {
        anlegen: {
          titel: 'Reparaturanfrage Erika Musterfrau (zweites Gerät)',
          zusatz: { ...ANFRAGE, fehlerbeschreibung: 'Zweites Gerät: LED-Beleuchtung fällt aus.' },
        },
        annehmen: (ctx) => ({ variant_id: ctx.geraetId, under_warranty: true, label_senden: true }),
      },
      pruefen: async (sql, _ctx, vorgangId) => {
        const kunden = await sql<{ id: string }[]>`
          select id from partners where lower(email) = ${ANFRAGE.email}`
        assert.equal(kunden.length, 1, 'kein zweiter Kontakt für dieselbe E-Mail')
        const [v] = await sql<{ partner_id: string | null }[]>`
          select partner_id from vorgaenge where id = ${vorgangId}`
        assert.equal(v.partner_id, kunden[0].id)
        const [auftrag] = await sql<{ under_warranty: boolean; state: string }[]>`
          select under_warranty, state from repair_orders
          where origin_model = 'vorgang' and origin_id = ${vorgangId}`
        assert.equal(auftrag.under_warranty, true, 'Garantie entscheidet der Mitarbeiter bei der Annahme')
        assert.equal(auftrag.state, 'awaiting_device')
      },
    },
    {
      name: 'annehmen ohne Retourenlabel (Walk-in): Auftrag bleibt neu',
      pfad: ['anlegen', 'annehmen'],
      eingaben: {
        anlegen: {
          titel: 'Reparaturanfrage Max Mustermann',
          zusatz: {
            ...ANFRAGE,
            kontakt_name: 'Max Mustermann',
            email: 'walkin@example.com',
            bestellnummer: '',
          },
        },
        annehmen: (ctx) => ({ variant_id: ctx.geraetId, under_warranty: false, label_senden: false }),
      },
      pruefen: async (sql, _ctx, vorgangId) => {
        const [auftrag] = await sql<{ state: string; note: string | null }[]>`
          select state, note from repair_orders
          where origin_model = 'vorgang' and origin_id = ${vorgangId}`
        assert.equal(auftrag.state, 'new', 'ohne Label wartet nichts — Bestätigen ist der nächste Schritt')
        assert.doesNotMatch(auftrag.note ?? '', /Bestellnummer/, 'leere Bestellnummer erscheint nicht')
        const labels = await sql<{ id: string }[]>`
          select rl.id from return_labels rl
          join repair_orders r on r.id = rl.repair_order_id
          where r.origin_id = ${vorgangId}`
        assert.equal(labels.length, 0)
      },
    },
    {
      name: 'ablehnen: Prozess zu Ende, kein Auftrag',
      pfad: ['anlegen', 'ablehnen'],
      eingaben: {
        anlegen: {
          titel: 'Reparaturanfrage Spam',
          zusatz: { ...ANFRAGE, email: 'spam@example.com', fehlerbeschreibung: 'Bitte Angebot für 500 Stück.' },
        },
        ablehnen: { vermerk: 'Keine Reparatur — Vertriebsanfrage.' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, vorgangId) => {
        const [v] = await sql<{ state: string }[]>`select state from vorgaenge where id = ${vorgangId}`
        assert.equal(v.state, 'abgelehnt')
        const auftraege = await sql<{ id: string }[]>`
          select id from repair_orders where origin_model = 'vorgang' and origin_id = ${vorgangId}`
        assert.equal(auftraege.length, 0)
      },
    },
  ],
}
