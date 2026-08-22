import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { currentUser } from '@/modules/auth'
import { sql } from '@/db/client'
import { aufnahmeKonfiguriert } from '@/modules/ki/prozess-aufnahme'
import { versionDiagramm } from '@/modules/prozesse/version-diagramm'
import { type EntwurfInfo, Wizard } from './wizard'
import './einrichtung.css'

export const dynamic = 'force-dynamic'
// Demodaten-Einspielen baut eine komplette Betriebshistorie — das darf dauern.
export const maxDuration = 300

/**
 * Ersteinrichtung einer frischen Instanz. Liegt bewusst AUSSERHALB der
 * (erp)-Gruppe (Muster /login) — die Weiche im ERP-Layout leitet hierher,
 * solange die Einrichtung offen ist; danach nie wieder (settings.einrichtung
 * überlebt auch die Gefahrenzone).
 *
 * Die Seite liest, der Assistent handelt: alles Schreibende läuft über
 * Registry-Aktionen (actions.ts). Mit `?entwurf=<code>` lädt sie zusätzlich
 * die aufgenommene Prozessversion samt Diagramm — das ist der Rückweg aus
 * der Aufnahme in Schritt 04.
 */
export default async function EinrichtungPage({
  searchParams,
}: {
  searchParams: Promise<{ entwurf?: string; erneut?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/login')

  const params = await searchParams
  // Nach dem Abschluss ist die Einrichtung zu — mit einer Ausnahme:
  // Administratoren dürfen sie mit ?erneut=1 noch einmal durchlaufen.
  // Sonst gäbe es keine Möglichkeit, sie anzusehen oder vorzuführen, ohne
  // eine Instanz wegzuwerfen. Der Durchlauf ist ECHT, nicht simuliert —
  // was hier gespeichert wird, ist gespeichert; deshalb steht das auch so
  // im Kopf der Seite.
  const erneut = params.erneut === '1' && user.role === 'admin'
  const [fertig] = await sql<{ key: string }[]>`
    select key from settings where key = 'einrichtung'`
  if (fertig && !erneut) redirect('/')

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

  const [pakete, firmaZeile, nutzer, instanzZahlen, kopf] = await Promise.all([
    sql<{ code: string; name: string; beschreibung: string | null }[]>`
      select code, name, beschreibung from prozess_pakete order by code`,
    sql<{ value: Record<string, string> }[]>`select value from settings where key = 'company'`,
    sql<{ id: string; name: string; email: string; role: string }[]>`
      select id, name, email, role from users where active order by created_at`,
    sql<{ migrationen: number; module: number }[]>`
      select (select count(*)::int from schema_migrations) as migrationen,
             (select count(distinct bereich)::int from prozesse) as module`,
    headers(),
  ])

  const entwurf = params.entwurf ? await entwurfLaden(params.entwurf) : null

  return (
    <Wizard
      adminId={user.id}
      adminName={user.name}
      pakete={pakete}
      firma={firmaZeile[0]?.value ?? {}}
      instanz={{
        // Der echte Host statt eines erfundenen Platzhalters — die Instanz
        // steht ja bereits, wenn jemand diese Seite sieht.
        host: kopf.get('x-forwarded-host') ?? kopf.get('host') ?? 'diese Instanz',
        region: process.env.INSTANZ_REGION ?? 'EU-Central · Frankfurt',
        migrationen: instanzZahlen[0]?.migrationen ?? 0,
        module: instanzZahlen[0]?.module ?? 0,
      }}
      team={nutzer}
      entwurf={entwurf}
      kiBereit={aufnahmeKonfiguriert()}
      erneut={erneut}
    />
  )
}

/**
 * Der frisch aufgenommene Entwurf: gezeigt wird die ENTWURFS-Version, nicht
 * die aktive (dieselbe Auswahl wie in der Prozess-Werkstatt) — abgenommen
 * und geschaltet wird genau das, was der Kunde gerade erzählt hat.
 */
async function entwurfLaden(code: string): Promise<EntwurfInfo | null> {
  const gefunden = await versionDiagramm(code)
  if (!gefunden) return null

  const entwurfsVersion = gefunden.versionen.find((v) => v.status === 'entwurf')
  const daten =
    entwurfsVersion && gefunden.gezeigt.status !== 'entwurf'
      ? ((await versionDiagramm(code, entwurfsVersion.version)) ?? gefunden)
      : gefunden

  const [abnahme] = await sql<{ abnahme_am: Date | null }[]>`
    select abnahme_am from prozess_versionen where id = ${daten.gezeigt.id}`

  // Die eigenen Felder des Entwurfs — sie gehören mit in die Abnahme.
  const felder = await sql<{ name: string; label: string; typ: string; sichtbar_in: string[] }[]>`
    select name, label, typ, sichtbar_in from feld_definitionen
    where prozess_code = ${code} order by sequence, name`

  return {
    code: daten.prozess.code,
    name: daten.prozess.name,
    version: Number(daten.gezeigt.version),
    status: daten.gezeigt.status,
    abgenommen: Boolean(abnahme?.abnahme_am),
    schritte: daten.schritte.map((s) => ({ code: s.code, name: s.name, art: s.art })),
    felder: felder.map((f) => ({
      name: f.name,
      label: f.label,
      typ: f.typ,
      in_liste: f.sichtbar_in.includes('liste'),
    })),
    diagramm: daten.diagramm,
  }
}
