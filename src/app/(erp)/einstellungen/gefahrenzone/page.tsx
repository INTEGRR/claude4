import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import type { ActionResult } from '@/modules/shared/action'

export const dynamic = 'force-dynamic'

/**
 * Gefahrenzone, zwei Stufen — beide über den Torwächter (Registry), damit
 * sie im Protokoll stehen wie jede andere Aktion; bestätigt wird durch ein
 * eingetipptes Wort, geprüft im Schema. Bewusst KEINE KI-Freigabe: das hier
 * drückt ein Mensch.
 */
async function betriebsdatenLoeschen(formData: FormData): Promise<ActionResult> {
  'use server'
  return serverAktion('einstellungen.betriebsdaten_loeschen', { formData })
}

async function werkszustandHerstellen(formData: FormData): Promise<ActionResult> {
  'use server'
  return serverAktion('einstellungen.werkszustand', { formData })
}

export default async function GefahrenzonePage() {
  await requireArea('einstellungen')
  const [bestand] = await sql<{ produkte: number; partner: number; belege: number; bewegungen: number }[]>`
    select (select count(*) from product_templates)::int as produkte,
           (select count(*) from partners)::int          as partner,
           (select count(*) from sales_orders)::int
             + (select count(*) from purchase_orders)::int
             + (select count(*) from manufacturing_orders)::int as belege,
           (select count(*) from stock_moves)::int       as bewegungen`
  const demo = await einstellung<{ geloescht: boolean }>('demo')

  return (
    <>
      <EinstellungenKopf href="/einstellungen/gefahrenzone" />

      {/* Zwei Stufen, weil „alles löschen" zwei sehr verschiedene Dinge heißen
          kann: die Beispieldaten loswerden — oder die Instanz auf den
          Auslieferungsstand zurückdrehen. */}
      <Card title="Stufe 1: Betriebsdaten löschen">
        <p style={{ marginTop: 0 }}>
          Löscht <strong>alle</strong> Belege, Produkte, Partner, Bestände, Buchungen und Protokolle —
          gedacht, um die Beispieldaten vor dem echten Betrieb restlos zu entfernen. Zurzeit im System:{' '}
          <strong>{bestand.produkte}</strong> Produkte, <strong>{bestand.partner}</strong> Partner,{' '}
          <strong>{bestand.belege}</strong> Belege, <strong>{bestand.bewegungen}</strong> Lagerbewegungen.
        </p>
        <p>
          Erhalten bleiben: Benutzerkonten samt zweitem Faktor (außer den Demo-Konten{' '}
          <span className="mono small">lager@example.com</span> und{' '}
          <span className="mono small">fertigung@example.com</span>), Firmendaten, das komplette
          Prozessmodell, Lagerorte, Einheiten, Steuern, Zahlungsbedingungen, alle Einstellungen und die
          Registrierungen der Startseite. Belegnummern starten wieder bei 1. Beispieldaten kommen nur auf
          ausdrücklichen Befehl zurück (<span className="mono small">npm run db:seed -- --demo</span>).
        </p>
        {demo.geloescht ? (
          <div className="notice info" style={{ marginBottom: 12 }}>
            Die Beispieldaten wurden bereits gelöscht. Ein erneuter Durchlauf leert das System wieder vollständig.
          </div>
        ) : null}
        <div className="notice danger">
          Das lässt sich nicht rückgängig machen. Zur Bestätigung exakt <strong>ALLES LÖSCHEN</strong> eintippen.
        </div>
        <ActionForm action={betriebsdatenLoeschen}>
          <div className="row">
            <label className="field">
              <span>Bestätigung</span>
              <input className="mono" name="bestaetigung" placeholder="ALLES LÖSCHEN" autoComplete="off" />
            </label>
            <div className="shrink field">
              <button className="danger" type="submit">Unwiderruflich löschen</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card title="Stufe 2: Werkszustand herstellen">
        <p style={{ marginTop: 0 }}>
          Dreht die Instanz auf den Stand zurück, den sie frisch nach der Provisionierung hatte —
          <strong> die Ersteinrichtung startet danach wieder von vorn</strong>. Zusätzlich zu Stufe 1 fallen:
        </p>
        <ul>
          <li>
            alle selbst gebauten <strong>Prozessversionen und Entwürfe</strong> (der Auslieferungsstand aus
            den Migrationen bleibt), dazu eigene Felder und abgeschaltete Schritte
          </li>
          <li>die Paketwahl — die Navigation zeigt danach wieder alle Prozesse</li>
          <li>alle <strong>Benutzerkonten außer dem eigenen</strong> (sonst käme niemand mehr hinein)</li>
          <li>die Firmendaten (zurück auf den Vorgabewert)</li>
        </ul>
        <p className="muted small">
          Nicht angefasst: technische Einstellungen (Labelformat, Druckweg, Freigabegrenze,
          Finanz-Stellschrauben, Kartonagen, Versandregeln), Lagerorte, Einheiten, Steuern,
          Zahlungsbedingungen und die Registrierungen der Startseite — das ist Einrichtung des
          Betreibers, kein Datenbestand.
        </p>
        <div className="notice danger">
          Härter als Stufe 1 und ebenfalls endgültig. Zur Bestätigung exakt <strong>WERKSZUSTAND</strong> eintippen.
        </div>
        <ActionForm action={werkszustandHerstellen}>
          <div className="row">
            <label className="field">
              <span>Bestätigung</span>
              <input className="mono" name="bestaetigung" placeholder="WERKSZUSTAND" autoComplete="off" />
            </label>
            <div className="shrink field">
              <button className="danger" type="submit">Werkszustand herstellen</button>
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  )
}
