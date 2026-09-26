import { PageHeader } from '@/components/ui'
import { bereichZu } from '@/modules/einstellungen/bereiche'

/**
 * Seitenkopf jedes Einstellungsbereichs: Titel und Untertitel kommen aus der
 * Landkarte (modules/einstellungen/bereiche.ts) — so heißen Navigation und
 * Seite immer gleich. Der Wächter verlangt diesen Kopf auf jeder Seite.
 */
export function EinstellungenKopf({
  href,
  untertitel,
  actions,
}: {
  href: string
  /** Nur für dynamische Untertitel (z. B. „3 offen") — sonst gilt die Beschreibung. */
  untertitel?: string
  actions?: React.ReactNode
}) {
  const b = bereichZu(href)
  return <PageHeader kicker="Einstellungen" title={b.label} subtitle={untertitel ?? b.beschreibung} actions={actions} />
}
