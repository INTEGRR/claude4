import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { PrintButton } from '@/components/print-button'
import { packzettelDaten } from '@/modules/versand/packzettel-daten'
import { PackzettelAnsicht } from './packzettel-ansicht'

export const dynamic = 'force-dynamic'

/**
 * Packzettel für eine Lieferung — das Gegenstück zum Fertigungszettel für
 * Bestellungen ohne Fertigung und zugleich der Kommissionierbeleg
 * (docs/module/versand.md „Kommissionieren"). Mehrere auf einmal:
 * /versand/packzettel?ids=…
 */
export default async function PackzettelPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('lager')
  const { id } = await params
  const [zettel] = await packzettelDaten([id])
  if (!zettel) notFound()

  return (
    <>
      <PackzettelAnsicht zettel={zettel} />
      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href={`/lager/${id}`}>Zurück zur Lieferung</a>
      </div>
    </>
  )
}
