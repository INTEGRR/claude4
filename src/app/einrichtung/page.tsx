import { redirect } from 'next/navigation'
import { currentUser } from '@/modules/auth'
import { sql } from '@/db/client'
import { HexcoreMark, Wortmarke } from '@/components/marke'
import { Wizard } from './wizard'

export const dynamic = 'force-dynamic'
// Demodaten-Einspielen baut eine komplette Betriebshistorie — das darf dauern.
export const maxDuration = 300

/**
 * Ersteinrichtung einer frischen Instanz: die Weiche „Demo-Modus oder
 * geführtes Onboarding". Liegt bewusst AUSSERHALB der (erp)-Gruppe (Muster
 * /login) — die Weiche im ERP-Layout leitet hierher, solange die
 * Einrichtung offen ist; danach nie wieder (settings.einrichtung überlebt
 * auch die Gefahrenzone).
 */
export default async function EinrichtungPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const [fertig] = await sql<{ key: string }[]>`
    select key from settings where key = 'einrichtung'`
  if (fertig) redirect('/')

  if (user.role !== 'admin') {
    return (
      <main className="einrichtung">
        <div className="card" style={{ maxWidth: 480, margin: '10vh auto' }}>
          <div className="body">
            <p>
              Diese Instanz ist noch nicht eingerichtet — das übernimmt der
              Administrator beim ersten Anmelden.
            </p>
          </div>
        </div>
      </main>
    )
  }

  const pakete = await sql<{ code: string; name: string; beschreibung: string | null }[]>`
    select code, name, beschreibung from prozess_pakete order by code`
  const [firma] = await sql<{ value: Record<string, string> }[]>`
    select value from settings where key = 'company'`

  return (
    <main className="einrichtung">
      <div style={{ maxWidth: 720, margin: '6vh auto', padding: '0 16px' }}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 6 }}>
          <HexcoreMark groesse={28} variante="einfach" />
          <Wortmarke groesse={22} />
        </div>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0 }}>
          Ersteinrichtung — einmalig, dauert wenige Minuten.
        </p>
        <Wizard adminId={user.id} pakete={pakete} firma={firma?.value ?? {}} />
      </div>
    </main>
  )
}
