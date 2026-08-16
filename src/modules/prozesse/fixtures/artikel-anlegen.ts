import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Der erste beleglose Assistent: Produkt mit Variantenmatrix anlegen,
 * optional gleich den Meldebestand einrichten. Läuft über prozess_instanzen —
 * derselbe Weg wie /p/artikel_anlegen mit generierten Masken.
 */
export const ARTIKEL_ANLEGEN: ProzessFixture = {
  prozess: 'artikel_anlegen',
  laeufe: [
    {
      name: 'Produkt mit Variantenmatrix, dann Meldebestand',
      pfad: ['produkt', 'meldebestand', 'ende'],
      eingaben: {
        produkt: {
          name: 'Prozesstest Tastatur',
          sku: 'PT-KBD',
          verkaufspreis: 199,
          gewicht_g: 900,
          attribute: [
            {
              name: 'Farbe',
              werte: [
                { name: 'Schwarz', kuerzel: 'BK' },
                { name: 'Blau', kuerzel: 'BL' },
              ],
            },
          ],
        },
        // Die Variante existiert erst NACH dem Produkt-Schritt — deshalb als
        // Funktion über den Kontext, den der Interpreter im Lauf füllt.
        meldebestand: async (ctx, sql) => {
          const [variante] = await sql<{ id: string }[]>`
            select id from product_variants
            where template_id = ${ctx.artikel_anlegen_produkt_id} and active
            order by sku nulls last limit 1`
          return { variant_id: variante.id, min_qty: 5, max_qty: 20 }
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, instanzId) => {
        const [instanz] = await sql<{ status: string; daten: Record<string, unknown> }[]>`
          select status, daten from prozess_instanzen where id = ${instanzId}`
        assert.equal(instanz.status, 'fertig')

        const templateId = String(instanz.daten.produkt_record_id)
        const [{ varianten }] = await sql<{ varianten: number }[]>`
          select count(*)::int as varianten from product_variants
          where template_id = ${templateId} and active`
        assert.equal(varianten, 2, 'Farbe Schwarz/Blau ergibt zwei Varianten')

        const [meldung] = await sql<{ id: string }[]>`
          select op.id from stock_orderpoints op
          join product_variants pv on pv.id = op.variant_id
          where pv.template_id = ${templateId} limit 1`
        assert.ok(meldung, 'der Meldebestand hängt an einer Variante des neuen Produkts')
      },
    },
    {
      name: 'ohne Meldebestand direkt abschließen',
      pfad: ['produkt', 'ende'],
      eingaben: {
        produkt: { name: 'Prozesstest Einfachprodukt' },
      },
      danachKeineSchritte: true,
    },
  ],
}
