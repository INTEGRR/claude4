import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { PageHeader } from '@/components/ui'
import { AbverkaufBrett } from '@/components/abverkauf-brett'
import { abverkaufStand } from '@/modules/verkauf/abverkauf'
import { fensterAus } from '@/modules/verkauf/abverkauf-logik'
import { serverAktion } from '@/modules/prozesse/server-aktion'

export const dynamic = 'force-dynamic'

/** Dieselbe Aktion wie „Für den Shop sperren" in der Shop-Verfügbarkeit — hier als ein Knopf je Teil. */
async function teilSperren(variantId: string, gesperrt: boolean) {
  'use server'
  return serverAktion('verkauf.shop_variante_setzen', { parameter: { variant_id: variantId, zurueckhalten: gesperrt } })
}

/**
 * Abverkauf (0144, Entscheidungslog 2026-11-27): das Command Center für
 * den Release-Tag — was verkauft sich wie schnell, welches Teil geht als
 * Nächstes aus, und ein Knopf, der ein Teil sofort für den Shop auf 0 setzt.
 */
export default async function AbverkaufPage({
  searchParams,
}: {
  searchParams: Promise<{ fenster?: string; projekt?: string }>
}) {
  const user = await requireArea('verkauf')
  const darf = canWrite(user.rollen, 'verkauf', user.befugnisse)
  const sp = await searchParams
  const stand = await abverkaufStand(fensterAus(sp.fenster), sp.projekt?.trim() || null)

  return (
    <>
      <PageHeader
        title="Abverkauf"
        subtitle="Live: was sich verkauft, welches Teil als Nächstes ausgeht — und der Knopf, der es sofort auf ausverkauft setzt"
      />
      <AbverkaufBrett anfang={stand} darf={darf} teilSperren={teilSperren} />
    </>
  )
}
