import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { moZettelDaten } from '@/modules/fertigung/zettel-daten'
import { PrintButton } from '@/components/print-button'
import { ZettelAnsicht } from '../zettel-ansicht'

export const dynamic = 'force-dynamic'

/**
 * Sammeldruck der Fertigungszettel (?ids=…,…) — der Browser-Fallback des
 * Bulk-Drucks, wenn keine Druckbrücke konfiguriert ist: alle ausgewählten
 * Zettel in einem Dokument, Seitenumbruch je Auftrag.
 */
export default async function MoSammeldruckPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>
}) {
  await requireArea('fertigung')
  const { ids } = await searchParams
  const liste = (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
  if (liste.length === 0) notFound()

  const zettel = (await Promise.all(liste.map((id) => moZettelDaten(id)))).filter(
    (d): d is NonNullable<typeof d> => d !== null,
  )
  if (zettel.length === 0) notFound()

  return (
    <>
      {zettel.map((daten, i) => (
        <div key={daten.mo.number} style={i > 0 ? { breakBefore: 'page' } : undefined}>
          <ZettelAnsicht daten={daten} />
        </div>
      ))}
      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href="/fertigung">Zurück zur Fertigung</a>
      </div>
    </>
  )
}
