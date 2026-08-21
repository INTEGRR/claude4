import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { Card, PageHeader } from '@/components/ui'
import { Liste, type Registrierung } from './liste'

export const dynamic = 'force-dynamic'

/**
 * Eingang der öffentlichen Startseite: wer sich über /start gemeldet hat.
 * Die Seite ist bewusst eine Arbeitsliste und kein CRM — Stand setzen,
 * Notiz dranschreiben, fertig. Offene stehen oben.
 */
export default async function RegistrierungenPage() {
  await requireArea('einstellungen')
  await requireAdmin()

  const zeilen = await sql<Registrierung[]>`
    select id, firma, ansprechpartner, email, telefon, nutzer, heutiges_system,
           ablauf, status, notiz, bearbeitet_durch,
           to_char(created_at, 'DD.MM.YYYY HH24:MI') as eingang
    from registrierungen
    order by (status = 'offen') desc, created_at desc
    limit 200`

  const offen = zeilen.filter((z) => z.status === 'offen').length

  return (
    <>
      <PageHeader
        title="Registrierungen"
        subtitle={
          offen > 0
            ? `${offen} offen — Eingänge vom Formular der öffentlichen Startseite.`
            : 'Eingänge vom Formular der öffentlichen Startseite.'
        }
      />

      {zeilen.length === 0 ? (
        <Card title="Noch nichts eingegangen">
          <p className="muted">
            Sobald sich jemand über die Startseite meldet, steht die Anfrage hier.
            Hinweis-Mails gehen an die Adresse aus <code>REGISTRIERUNG_MAIL</code>,
            sofern der Mailversand konfiguriert ist.
          </p>
        </Card>
      ) : (
        <Liste zeilen={zeilen} />
      )}
    </>
  )
}
