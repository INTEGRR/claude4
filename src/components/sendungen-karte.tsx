import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Badge, Card } from '@/components/ui'
import { pflichtdokumenteNachfragen } from '@/app/(erp)/einkauf/sendungen/actions'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { SENDUNG_MODI, type SendungModus } from '@/modules/einkauf/sendungen'
import { date } from '@/modules/shared/format'

/**
 * Baustein an der Bestellung (0108): mit welchen Eingangssendungen sie reist
 * und welche Pflichtdokumente fehlen (PI, CI, Packing List, Endrechnung) —
 * mit „Beim Lieferanten nachfragen" (Mail-Entwurf in seiner Sprache).
 */
export async function SendungenKarte({ purchaseOrderId }: { purchaseOrderId: string }) {
  const [sendungen, fehlend, user] = await Promise.all([
    sql<{ id: string; nummer: string; bezeichnung: string | null; status: string; modus: SendungModus; eta: string | null; verschifft_am: string | null }[]>`
      select s.id, s.nummer, s.bezeichnung, s.status::text as status, s.modus, s.eta::text as eta, s.verschifft_am::text as verschifft_am
      from eingangs_sendung_bestellungen b join eingangs_sendungen s on s.id = b.sendung_id
      where b.purchase_order_id = ${purchaseOrderId}
      order by s.created_at`,
    sql<{ bezeichnung: string; faellig_am: string | null }[]>`
      select bezeichnung, faellig_am::text as faellig_am from einkauf_offene_pflichtdokumente
      where modell = 'purchase_order' and record_id = ${purchaseOrderId} order by art`,
    currentUser(),
  ])
  if (sendungen.length === 0 && fehlend.length === 0) return null
  const darf = Boolean(user && canWrite(user.rollen, 'einkauf', user.befugnisse))

  return (
    <Card
      title="Sendungen & Pflichtdokumente"
      tight
      actions={
        <Link className="btn small" href="/einkauf/sendungen">
          Sendungen
        </Link>
      }
    >
      {sendungen.length > 0 && (
        <ul className="dok-liste">
          {sendungen.map((s) => (
            <li key={s.id} className="dok-zeile">
              <div className="dok-text">
                <Link href={`/einkauf/sendungen/${s.id}`} className="dok-name">
                  <span className="mono">{s.nummer}</span>
                  {s.bezeichnung ? ` ${s.bezeichnung}` : ''}
                </Link>
                <div className="muted small">
                  {SENDUNG_MODI[s.modus]}
                  {s.verschifft_am ? ` · verschifft ${date(s.verschifft_am)}` : ''}
                  {s.eta ? ` · ETA ${date(s.eta)}` : ''}
                </div>
              </div>
              <Badge state={s.status} kind="eingangs_sendung" href={`/einkauf/sendungen/${s.id}`} />
            </li>
          ))}
        </ul>
      )}
      {fehlend.length > 0 && (
        <div style={{ padding: '10px 12px' }}>
          <div className="mono-label" style={{ marginBottom: 4 }}>
            Fehlt
          </div>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {fehlend.map((f) => (
              <li key={f.bezeichnung} className="small">
                {f.bezeichnung}
                {f.faellig_am ? <span className="muted"> · fällig seit {date(f.faellig_am)}</span> : null}
              </li>
            ))}
          </ul>
          {darf && (
            <ActionButton className="small" action={pflichtdokumenteNachfragen.bind(null, 'purchase_order', purchaseOrderId)}>
              Beim Lieferanten nachfragen
            </ActionButton>
          )}
        </div>
      )}
    </Card>
  )
}
