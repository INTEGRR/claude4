import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { moZettelDaten } from '@/modules/fertigung/zettel-daten'
import { PrintButton } from '@/components/print-button'
import { ZettelAnsicht } from '../../zettel-ansicht'

export const dynamic = 'force-dynamic'

/**
 * Druckbeleg für die Werkstatt UND den Packtisch: Kopfdaten mit zwei
 * beschrifteten Barcodes — FERTIGUNG (schließt am Scanner die Produktion
 * ab) und VERSAND (öffnet am Packtisch die Lieferung des Auftrags) —,
 * dazu der Artikel-Code des Erzeugnisses und die eingefrorene,
 * variantengefilterte Komponentenliste zum Abhaken. Der Zettel wandert
 * mit der Ware bis zum Packtisch (docs/module/versand.md). Ansicht und
 * Daten teilen sich Einzeldruck, Sammeldruck und das PDF der Druckbrücke.
 */
export default async function MoPrintPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('fertigung')
  const { id } = await params

  const daten = await moZettelDaten(id)
  if (!daten) notFound()

  return (
    <>
      <ZettelAnsicht daten={daten} />
      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href={`/fertigung/${id}`}>Zurück zum Auftrag</a>
      </div>
    </>
  )
}
