import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { PrintButton } from '@/components/print-button'
import { packzettelDaten } from '@/modules/versand/packzettel-daten'
import { PackzettelAnsicht } from '../../lager/[id]/druck/packzettel-ansicht'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sammeldruck der Packzettel (?ids=…,…) — der Browser-Weg der Auswahl im
 * Versand, wenn kein Drucker am Arbeitsplatz steht: alle Zettel in einem
 * Dokument, Seitenumbruch je Lieferung (0091).
 */
export default async function PackzettelSammeldruck({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>
}) {
  await requireArea('versand')
  const { ids } = await searchParams
  const liste = (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID.test(s))
    .slice(0, 100)
  const zettel = await packzettelDaten(liste)
  if (zettel.length === 0) notFound()

  return (
    <>
      {zettel.map((z, i) => (
        <div key={z.kopf.id} style={i > 0 ? { breakBefore: 'page' } : undefined}>
          <PackzettelAnsicht zettel={z} />
        </div>
      ))}
      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href="/versand">Zurück zum Versand</a>
      </div>
    </>
  )
}
