import { z } from 'zod'

/**
 * Diagramm-Beschreibung, die der Agent liefert. Bewusst schmal gehalten: der
 * Agent bestimmt *was* gezeigt wird, das Aussehen bleibt bei den vorhandenen
 * Diagrammkomponenten — sonst hätte jede Antwort ihren eigenen Stil.
 */
export const diagrammSchema = z
  .object({
    art: z.enum(['saeulen', 'balken', 'anteile']),
    titel: z.string().min(1).max(120),
    einheit: z.string().max(12).optional(),
    /** Nur bei 'saeulen': die Achsenbeschriftung, z. B. Monate. */
    kategorien: z.array(z.string().max(40)).max(24).optional(),
    /** Nur bei 'saeulen': eine oder mehrere Reihen über die Kategorien. */
    serien: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          werte: z.array(z.number().finite()).max(24),
        }),
      )
      .max(6)
      .optional(),
    /** Bei 'balken' und 'anteile': einzelne Werte mit Beschriftung. */
    punkte: z
      .array(z.object({ label: z.string().min(1).max(60), wert: z.number().finite() }))
      .max(20)
      .optional(),
  })
  .superRefine((d, ctx) => {
    if (d.art === 'saeulen') {
      if (!d.kategorien?.length || !d.serien?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Für "saeulen" werden kategorien und serien gebraucht.',
        })
        return
      }
      for (const s of d.serien) {
        if (s.werte.length !== d.kategorien.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Serie "${s.name}" hat ${s.werte.length} Werte, es gibt aber ${d.kategorien.length} Kategorien.`,
          })
        }
      }
    } else if (!d.punkte?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Für "${d.art}" werden punkte gebraucht.`,
      })
    }
  })

export type Diagramm = z.infer<typeof diagrammSchema>

/** Werkzeugbeschreibung für das Modell. */
export const DIAGRAMM_TOOL = {
  name: 'diagramm',
  description:
    'Zeigt ein Diagramm im Chat an. Nutze es, wenn ein Verlauf, ein Vergleich oder eine ' +
    'Verteilung anschaulicher ist als eine Tabelle — die Zahlen gehören trotzdem zusätzlich ' +
    'in den Text. Drei Arten: "saeulen" für Verläufe über Kategorien (z. B. Monate, mit ' +
    'kategorien + serien), "balken" für eine Rangliste (punkte) und "anteile" für die ' +
    'Aufteilung eines Ganzen (punkte, nur positive Werte). Höchstens 6 Serien bzw. 20 Punkte.',
  input_schema: {
    type: 'object' as const,
    properties: {
      art: { type: 'string', enum: ['saeulen', 'balken', 'anteile'] },
      titel: { type: 'string', description: 'Überschrift des Diagramms' },
      einheit: { type: 'string', description: 'z. B. "€", "Stück", "Tage"' },
      kategorien: {
        type: 'array',
        items: { type: 'string' },
        description: 'nur bei art=saeulen: Beschriftung der Achse',
      },
      serien: {
        type: 'array',
        description: 'nur bei art=saeulen: je Serie ein Wert pro Kategorie',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            werte: { type: 'array', items: { type: 'number' } },
          },
          required: ['name', 'werte'],
        },
      },
      punkte: {
        type: 'array',
        description: 'bei art=balken/anteile',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, wert: { type: 'number' } },
          required: ['label', 'wert'],
        },
      },
    },
    required: ['art', 'titel'],
  },
}
