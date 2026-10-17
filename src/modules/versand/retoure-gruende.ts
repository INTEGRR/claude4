/**
 * Rücksendegründe (0119) — dieselbe Liste im Portal und in der internen
 * Anlage, damit die Auswertung später nach Gründen zählen kann. Freitext
 * bleibt im Anliegen.
 */
export const RETOURE_GRUENDE = [
  'Gefällt mir nicht / passt nicht',
  'Falscher Artikel bestellt',
  'Falscher Artikel geliefert',
  'Beschädigt angekommen',
  'Funktioniert nicht',
  'Anderer Grund',
] as const

export type RetoureGrund = (typeof RETOURE_GRUENDE)[number]
