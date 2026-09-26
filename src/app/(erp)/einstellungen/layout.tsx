import { requireArea } from '@/modules/auth'
import { EinstellungenNav } from '@/components/einstellungen-nav'

/**
 * Rahmen der Einstellungen: links die gruppierte Unternavigation, rechts der
 * Bereich. Der Guard hier ist Komfort — Layouts laufen bei Navigation
 * zwischen Geschwisterseiten nicht neu, deshalb prüft JEDE Seite selbst
 * (requireArea('einstellungen')).
 */
export default async function EinstellungenLayout({ children }: { children: React.ReactNode }) {
  await requireArea('einstellungen')
  return (
    <div className="einstellungen">
      <EinstellungenNav />
      <div className="einstellungen-inhalt">{children}</div>
    </div>
  )
}
