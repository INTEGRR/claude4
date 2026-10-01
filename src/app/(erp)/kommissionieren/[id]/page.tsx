import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { PageHeader } from '@/components/ui'
import { einstellung } from '@/modules/einstellungen/lesen'
import { sammelDoc } from '@/modules/versand/kommissionieren'
import { Sammeln } from './sammeln'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sammel-Screen einer Lieferung (0091). Gesammelt wird nur, wer die
 * Lieferung beansprucht hat (lager.kommissionierung_starten) — sonst
 * zeigt die Seite, wer gerade sammelt, oder (im Screen) den Knopf zum
 * Beginnen.
 */
export default async function SammelnPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('versand')
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const doc = await sammelDoc(id)
  if (!doc) notFound()
  const einstellungen = await einstellung<{ manuell_bestaetigen: boolean }>('kommissionieren')
  // Auftrag und Kunde als Wege im Kopf (Betreiber 2026-10-01).
  const [verweis] = await sql<{ auftrag_id: string | null; kunde_id: string | null }[]>`
    select so.id as auftrag_id, coalesce(so.partner_id, p.partner_id) as kunde_id
    from stock_pickings p
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    where p.id = ${id}`
  const auftrag = doc.shopify ?? doc.auftrag

  const kopf = (
    <PageHeader
      kicker="Kommissionieren"
      title={doc.number}
      mono
      subtitle={
        <>
          {auftrag &&
            (verweis?.auftrag_id ? (
              <Link className="mono" href={`/verkauf/${verweis.auftrag_id}`}>{auftrag}</Link>
            ) : (
              <span className="mono">{auftrag}</span>
            ))}
          {auftrag && doc.kunde && ' · '}
          {doc.kunde &&
            (verweis?.kunde_id ? (
              <Link href={`/kontakte/${verweis.kunde_id}`}>{doc.kunde}</Link>
            ) : (
              doc.kunde
            ))}
        </>
      }
      actions={
        <Link className="btn" href="/kommissionieren">
          Vorrat
        </Link>
      }
    />
  )

  let hinweis: React.ReactNode = null
  if (doc.state !== 'assigned') {
    hinweis = (
      <>
        {doc.state === 'done'
          ? 'Diese Lieferung ist bereits versendet.'
          : `Diese Lieferung ist nicht versandbereit (Status ${doc.state}).`}{' '}
        <Link href={`/lager/${doc.pickingId}`}>Zur Lieferung</Link>
      </>
    )
  } else if (doc.fertigungOffen.length > 0) {
    hinweis = (
      <>
        Wartet auf die Fertigung:{' '}
        {verweis?.auftrag_id ? (
          <Link className="mono" href={`/fertigung?auftrag=${verweis.auftrag_id}`}>
            {doc.fertigungOffen.join(', ')}
          </Link>
        ) : (
          <span className="mono">{doc.fertigungOffen.join(', ')}</span>
        )}{' '}
        — erst danach sammeln.
      </>
    )
  } else if (doc.sammler && doc.sammler !== user.name) {
    hinweis = `Wird gerade von ${doc.sammler} gesammelt. Die Sperre fällt nach 30 Minuten ohne Abschluss.`
  }

  if (hinweis) {
    return (
      <>
        {kopf}
        <div className="notice warn">{hinweis}</div>
      </>
    )
  }

  // Beim Sammeln zählt jeder Zentimeter Bildschirm: kein Seitenkopf, die
  // Nummer steht groß im Gerät selbst. Der Screen bleibt über „beginnen"
  // und „gemeldet" hinweg DERSELBE Baustein — sonst würfe das Neurendern
  // nach dem Melden (Sperre frei) den Abschluss-Zustand weg.
  return (
    <>
      <div className="kommi-zurueck">
        <Link href="/kommissionieren">← Vorrat</Link>
      </div>
      <Sammeln
        doc={doc}
        beansprucht={doc.sammler === user.name}
        manuell={Boolean(einstellungen.manuell_bestaetigen)}
      />
    </>
  )
}
