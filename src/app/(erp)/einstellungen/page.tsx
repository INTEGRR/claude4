import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { type ActionResult, actionError, actionFail, actionInfo } from '@/modules/shared/action'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { KI_EBENEN, MODELL_KATALOG, modellAufloesen } from '@/modules/ki/modelle'
import { Card, PageHeader, TableWrap } from '@/components/ui'

export const dynamic = 'force-dynamic'

interface Company {
  [key: string]: string | undefined
  name: string
  street: string
  house: string
  zip: string
  city: string
  country: string
  email?: string
  phone?: string
}

async function saveCompany(formData: FormData) {
  'use server'
  // Prozess First: die Firmendaten laufen wie alles über die Registry
  // (einstellungen.firma_speichern) — Torwächter prüft und auditiert.
  return serverAktion('einstellungen.firma_speichern', { formData })
}

async function saveKiModelle(formData: FormData) {
  'use server'
  // Prozess First: Modellwahl je KI-Ebene läuft über die Registry
  // (einstellungen.ki_modelle_setzen) — Torwächter prüft und auditiert.
  return serverAktion('einstellungen.ki_modelle_setzen', { formData })
}

async function saveDruckbruecke(formData: FormData) {
  'use server'
  // Prozess First: Druckweg-Umschaltung läuft über die Registry
  // (einstellungen.druckbruecke_setzen) — Torwächter prüft und auditiert.
  return serverAktion('einstellungen.druckbruecke_setzen', { formData })
}

async function saveDhl(formData: FormData) {
  'use server'
  await requireAdmin()
  const value = {
    default_product: String(formData.get('default_product') ?? 'V01PAK'),
    print_format: String(formData.get('print_format') ?? '910-300-700'),
  }
  try {
    await sql`update settings set value = ${sql.json(value)} where key = 'dhl'`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen')
  return actionInfo('Versandvorgaben gespeichert.')
}

async function savePolicies(formData: FormData) {
  'use server'
  await requireAdmin()
  try {
    await sql`update settings set value = ${sql.json({
      lock_confirmed: formData.get('sales_lock') === 'on',
    })} where key = 'sales'`
    await sql`update settings set value = ${sql.json({
      lock_confirmed: formData.get('purchase_lock') === 'on',
    })} where key = 'purchase'`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen')
  return actionInfo('Belegverhalten gespeichert.')
}

async function saveFreigaben(formData: FormData) {
  'use server'
  await requireAdmin()
  const roh = String(formData.get('einkauf_limit') ?? '').trim().replace(',', '.')
  if (roh !== '' && (!Number.isFinite(Number(roh)) || Number(roh) < 0)) {
    return actionError('Das Limit muss eine Zahl ≥ 0 sein — oder leer für „keine Freigabepflicht".')
  }
  // Leer = Freigabepflicht aus. Der Wert lebt NUR hier in den Einstellungen —
  // Trigger und Anzeige lesen ihn, nichts ist im Code festgelegt.
  const value = roh === '' ? {} : { einkauf_limit: Number(roh) }
  try {
    await sql`update settings set value = ${sql.json(value)} where key = 'freigaben'`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen')
  return actionInfo(
    roh === ''
      ? 'Freigabepflicht abgeschaltet — Bestellungen brauchen keine Freigabe mehr.'
      : `Gespeichert: Bestellungen ab ${Number(roh).toFixed(2)} € netto brauchen eine Freigabe.`,
  )
}

// Die Finanz-Stellschrauben (Quoten, Sätze, Zahltage, Band) — gemergt in den
// settings-Schlüssel 'finanzen', damit die NICHT im Formular stehenden
// Schlüssel (z. B. vertrag_kategorien) unangetastet bleiben.
const FINANZ_FELDER: { name: string; label: string; min?: number; max?: number }[] = [
  { name: 'wareneinsatz_pct', label: 'Wareneinsatz (% vom Planumsatz)', min: 0, max: 100 },
  { name: 'versand_pct', label: 'Versand (%)', min: 0, max: 100 },
  { name: 'fees_pct', label: 'Gebühren/Fees (%)', min: 0, max: 100 },
  { name: 'ust_satz_pct', label: 'USt-Satz (%)', min: 0, max: 100 },
  { name: 'ust_zahllast_quote_pct', label: 'USt-Zahllast-Quote (% vom Planumsatz)', min: 0, max: 100 },
  { name: 'ust_zahltag', label: 'USt-Zahltag (1–28)', min: 1, max: 28 },
  { name: 'ust_frist_monate', label: 'USt-Frist (Monate)', min: 0, max: 6 },
  { name: 'shopify_versatz_tage', label: 'Shopify-Auszahlung (Tage)', min: 0, max: 60 },
  { name: 'rechnung_versatz_tage', label: 'Zahlungsziel Rechnung (Tage)', min: 0, max: 120 },
  { name: 'best_aufschlag_pct', label: 'Best-Szenario: Aufschlag (%)', min: 0, max: 100 },
  { name: 'worst_abschlag_pct', label: 'Worst-Szenario: Abschlag (%)', min: 0, max: 100 },
  { name: 'liquiditaets_puffer', label: 'Liquiditätspuffer (€)', min: 0 },
  { name: 'transit_tage', label: 'Transitzeit See (Tage)', min: 0, max: 120 },
  { name: 'kuendigungs_vorlauf_tage', label: 'Kündigungs-Vorlauf (Tage)', min: 0, max: 365 },
]

async function saveFinanzen(formData: FormData) {
  'use server'
  await requireAdmin()
  const patch: Record<string, number> = {}
  for (const feld of FINANZ_FELDER) {
    const roh = String(formData.get(feld.name) ?? '').trim().replace(',', '.')
    const wert = Number(roh)
    if (roh === '' || !Number.isFinite(wert)) {
      return actionError(`„${feld.label}" muss eine Zahl sein.`)
    }
    if ((feld.min != null && wert < feld.min) || (feld.max != null && wert > feld.max)) {
      return actionError(
        `„${feld.label}" muss zwischen ${feld.min ?? 0} und ${feld.max ?? '∞'} liegen.`,
      )
    }
    patch[feld.name] = wert
  }
  try {
    // Rechte Seite gewinnt: die Formularwerte überschreiben, alles andere
    // im Schlüssel (vertrag_kategorien …) bleibt stehen.
    await sql`
      insert into settings (key, value) values ('finanzen', ${sql.json(patch)})
      on conflict (key) do update set value = settings.value || excluded.value`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/einstellungen')
  revalidatePath('/finanzen')
  return actionInfo('Finanz-Einstellungen gespeichert — die Prognose rechnet ab sofort damit.')
}

/**
 * Gefahrenzone, zwei Stufen — beide über den Torwächter (Registry), damit
 * sie im Protokoll stehen wie jede andere Aktion. Bewusst KEINE
 * KI-Freigabe: das hier drückt ein Mensch.
 */
async function betriebsdatenLoeschen(formData: FormData): Promise<ActionResult> {
  'use server'
  return serverAktion('einstellungen.betriebsdaten_loeschen', { formData })
}

async function werkszustandHerstellen(formData: FormData): Promise<ActionResult> {
  'use server'
  return serverAktion('einstellungen.werkszustand', { formData })
}

/**
 * Gespeicherter Zustand einer Belegregel — Leuchte plus Wort, nicht nur der
 * Haken. Zeigt den zuletzt gespeicherten Stand, nicht die Vorwahl im Formular.
 */
function Zustand({ an }: { an: boolean }) {
  return (
    <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={an ? 'led ok' : 'led off'} />
      {an ? 'gesperrt' : 'offen'}
    </span>
  )
}

export default async function EinstellungenPage() {
  await requireArea('einstellungen')
  const settings = await sql<{ key: string; value: Record<string, unknown> }[]>`
    select key, value from settings`
  const get = <T,>(key: string): T => (settings.find((s) => s.key === key)?.value ?? {}) as T

  const company = get<Company>('company')
  const dhl = get<{ default_product?: string; print_format?: string }>('dhl')
  const sales = get<{ lock_confirmed?: boolean }>('sales')
  const purchase = get<{ lock_confirmed?: boolean }>('purchase')
  const freigaben = get<{ einkauf_limit?: number }>('freigaben')
  const kiModelle = get<Record<string, unknown>>('ki_modelle')
  const druckbruecke = get<{ modus?: string; token?: string }>('druckbruecke')
  const druckModus = druckbruecke.modus === 'bruecke' ? 'bruecke' : 'pdf'
  const finanzen = get<Record<string, number>>('finanzen')

  // Der laufende Stand steht seit Migration 0026 in echten Sequenzen, nicht
  // mehr in der Tabellenspalte.
  const sequences = await sql<{ code: string; prefix: string; next_number: number }[]>`
    select code, prefix, next_number from sequence_state()`

  const [bestand] = await sql<{ produkte: number; partner: number; belege: number; bewegungen: number }[]>`
    select (select count(*) from product_templates)::int as produkte,
           (select count(*) from partners)::int          as partner,
           (select count(*) from sales_orders)::int
             + (select count(*) from purchase_orders)::int
             + (select count(*) from manufacturing_orders)::int as belege,
           (select count(*) from stock_moves)::int       as bewegungen`
  const [demoMerker] = await sql<{ value: { geloescht?: boolean } }[]>`
    select value from settings where key = 'demo'`

  return (
    <>
      <PageHeader
        title="Einstellungen"
        subtitle="Firmendaten, Versand und Belegverhalten"
        actions={
          <>
            <Link className="btn" href="/einstellungen/versandregeln">Versandregeln</Link>
            <Link className="btn" href="/einstellungen/kartonagen">Kartonagen</Link>
            <Link className="btn" href="/einstellungen/benutzer">Benutzer verwalten</Link>
            <Link className="btn" href="/einstellungen/nutzung">Nutzung</Link>
            <Link className="btn" href="/einstellungen/registrierungen">Registrierungen</Link>
            {/* Die Einrichtung ist nach dem Abschluss zu — Administratoren
                kommen mit ?erneut=1 noch einmal hinein (Vorführung, Prüfung).
                Der Durchlauf ist echt, nicht simuliert. */}
            <Link className="btn" href="/einrichtung?erneut=1">Einrichtung ansehen</Link>
          </>
        }
      />

      <Card title="Firmendaten (Absender für DHL-Labels und Belege)">
        <ActionForm action={saveCompany}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Firmenname</span>
              <input name="name" defaultValue={company.name} required />
            </label>
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" defaultValue={company.email ?? ''} />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" defaultValue={company.phone ?? ''} />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" defaultValue={company.street} required />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house" defaultValue={company.house} required />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input name="zip" defaultValue={company.zip} required />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" defaultValue={company.city} required />
            </label>
            <label className="field">
              <span>Land (ISO alpha-3)</span>
              <input className="mono" name="country" defaultValue={company.country} maxLength={3} required />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
      </Card>

      <Card title="Versand (DHL)">
        <ActionForm action={saveDhl}>
          <div className="row">
            <label className="field">
              <span>Standard-Produkt</span>
              <select name="default_product" defaultValue={dhl.default_product ?? 'V01PAK'}>
                <option value="V01PAK">V01PAK — DHL Paket national</option>
                <option value="V54EPAK">V54EPAK — Europaket</option>
                <option value="V53WPAK">V53WPAK — Paket International</option>
              </select>
            </label>
            <label className="field">
              <span>Label-Format</span>
              <select name="print_format" defaultValue={dhl.print_format ?? '910-300-700'}>
                <option value="910-300-700">910-300-700 (105 × 208 mm)</option>
                <option value="910-300-600">910-300-600 (Thermo 103 × 199)</option>
                <option value="910-300-400">910-300-400 (Thermo 103 × 150)</option>
                <option value="A4">A4</option>
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <div className="notice info" style={{ marginBottom: 0 }}>
          Zugangsdaten (API-Key, GKP-Benutzer, Abrechnungsnummer) werden aus Sicherheitsgründen als
          Umgebungsvariablen gesetzt, nicht hier. Hinweis: Das Passwort des GKP-Systembenutzers läuft
          nach 365 Tagen ab.
        </div>
      </Card>

      <Card title="KI-Modelle (Kosten und Qualität je Ebene)">
        <ActionForm action={saveKiModelle}>
          <div className="row">
            {KI_EBENEN.map((ebene) => (
              <label key={ebene.key} className="field">
                <span title={ebene.hinweis}>{ebene.label}</span>
                <select name={ebene.key} defaultValue={modellAufloesen(kiModelle, ebene.key)}>
                  {MODELL_KATALOG.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hinweis}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
          <div className="notice info" style={{ marginBottom: 0 }}>
            Gilt sofort für neue Anfragen. Faustregel: Opus für den Prozess-Entwurf, Sonnet für
            Auswertungen, Haiku für den Sprachmodus — so bleiben die Kosten im Rahmen, ohne
            Qualität dort zu verlieren, wo sie zählt.
          </div>
        </ActionForm>
      </Card>

      <Card title="Druckbrücke (Labels & Fertigungszettel)">
        <ActionForm action={saveDruckbruecke}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="radio" name="modus" value="pdf" defaultChecked={druckModus === 'pdf'} />
              <span>
                <strong>PDF im Browser</strong> — Labels und Zettel öffnen als Tab, gedruckt wird
                über den Browser-Dialog (zum Testen, ohne Einrichtung)
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="modus"
                value="bruecke"
                defaultChecked={druckModus === 'bruecke'}
              />
              <span>
                <strong>Druckbrücke</strong> — stiller Direktdruck über Agenten an den
                Arbeitsplatz-PCs (Labeldrucker am Packtisch, A4 in der Werkstatt)
              </span>
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Agent-Token (Ausweis der Druck-Agenten; leer = behalten bzw. beim Umstellen erzeugen)</span>
              <input
                type="text"
                name="token"
                className="mono"
                defaultValue={druckbruecke.token ?? ''}
                placeholder="wird beim Aktivieren der Brücke erzeugt"
              />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
          <div className="notice info" style={{ marginBottom: 0 }}>
            Gilt sofort, kein Redeploy nötig. Für die Brücke auf jedem Druck-PC einen Agenten mit
            diesem Token starten (<span className="mono">scripts/druck-agent.ts</span>, Anleitung
            in docs/module/versand.md); Zustand der Agenten auf der Integrationen-Seite.
          </div>
        </ActionForm>
      </Card>

      <Card title="Belegverhalten">
        <ActionForm action={savePolicies}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" name="sales_lock" defaultChecked={sales.lock_confirmed ?? false} />
              <span>Verkaufsaufträge beim Bestätigen automatisch sperren</span>
              <Zustand an={sales.lock_confirmed ?? false} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" name="purchase_lock" defaultChecked={purchase.lock_confirmed ?? false} />
              <span>Bestellungen beim Bestätigen automatisch sperren</span>
              <Zustand an={purchase.lock_confirmed ?? false} />
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
      </Card>

      <Card title="Freigaben">
        <ActionForm action={saveFreigaben}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Einkauf: Freigabe ab Bestellsumme (netto, €)</span>
              <input
                type="number"
                name="einkauf_limit"
                step="0.01"
                min="0"
                defaultValue={freigaben.einkauf_limit ?? ''}
                placeholder="leer = keine Freigabepflicht"
              />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
            <div className="shrink field">
              {freigaben.einkauf_limit != null ? (
                <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="led ok" /> aktiv ab {Number(freigaben.einkauf_limit).toFixed(2)} €
                </span>
              ) : (
                <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="led off" /> keine Freigabepflicht
                </span>
              )}
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Ab dieser Summe lässt sich eine Bestellung erst nach Freigabe bestätigen — auf jedem Weg
          (Knopf, API, KI). Wer freigeben darf, wird über die Befugnis „Bestellungen freigeben" in
          der <Link href="/einstellungen/benutzer">Benutzerverwaltung</Link> vergeben; Administratoren
          dürfen immer. Positionsänderungen lassen eine erteilte Freigabe erlöschen.
        </p>
      </Card>

      <Card title="Finanzen (Prognose-Stellschrauben)">
        <ActionForm action={saveFinanzen}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 12,
            }}
          >
            {FINANZ_FELDER.map((feld) => (
              <label className="field" key={feld.name}>
                <span>{feld.label}</span>
                <input
                  className="mono"
                  type="number"
                  name={feld.name}
                  step="any"
                  min={feld.min}
                  max={feld.max}
                  defaultValue={finanzen[feld.name] ?? ''}
                  required
                />
              </label>
            ))}
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Diese Werte steuern die Cashflow-Prognose unter <Link href="/finanzen">Finanzen</Link>:
          die Quoten rechnen variable Kosten vom Planumsatz, die Versätze verschieben Einzahlungen,
          das Band spannt Best/Worst um den Basisplan, der Puffer definiert, ab wann die Prognose
          Fremdkapitalbedarf ausweist. Nichts davon ist im Code festgelegt.
        </p>
      </Card>

      {/* Zwei Stufen, weil „alles löschen" zwei sehr verschiedene Dinge
          heißen kann: die Beispieldaten loswerden — oder die Instanz auf den
          Auslieferungsstand zurückdrehen. Die erste Stufe lässt die
          Einrichtung stehen, die zweite holt sie zurück. */}
      <Card title="Gefahrenzone · Stufe 1: Betriebsdaten löschen">
        <p style={{ marginTop: 0 }}>
          Löscht <strong>alle</strong> Belege, Produkte, Partner, Bestände, Buchungen und Protokolle —
          gedacht, um die Beispieldaten vor dem echten Betrieb restlos zu entfernen. Zurzeit im System:{' '}
          <strong>{bestand.produkte}</strong> Produkte, <strong>{bestand.partner}</strong> Partner,{' '}
          <strong>{bestand.belege}</strong> Belege, <strong>{bestand.bewegungen}</strong> Lagerbewegungen.
        </p>
        <p>
          Erhalten bleiben: Benutzerkonten (außer den Demo-Konten <span className="mono small">lager@example.com</span>{' '}
          und <span className="mono small">fertigung@example.com</span>), Firmendaten, das komplette
          Prozessmodell, Lagerorte, Einheiten, Steuern, Zahlungsbedingungen, die Shopify-/DHL-Konfiguration
          und die Registrierungen der Startseite. Belegnummern starten wieder bei 1.
          Beispieldaten werden grundsätzlich nie automatisch eingespielt — sie kommen nur auf ausdrücklichen
          Befehl zurück (<span className="mono small">npm run db:seed -- --demo</span>).
        </p>
        {demoMerker?.value?.geloescht ? (
          <div className="notice info" style={{ marginBottom: 12 }}>
            Die Beispieldaten wurden bereits gelöscht. Ein erneuter Durchlauf leert das System wieder vollständig.
          </div>
        ) : null}
        <div className="notice danger">
          Das lässt sich nicht rückgängig machen. Zur Bestätigung unten exakt{' '}
          <strong>ALLES LÖSCHEN</strong> eintippen.
        </div>
        <ActionForm action={betriebsdatenLoeschen}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
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

      <Card title="Gefahrenzone · Stufe 2: Werkszustand herstellen">
        <p style={{ marginTop: 0 }}>
          Dreht die Instanz auf den Stand zurück, den sie frisch nach der Provisionierung hatte —
          <strong> die Ersteinrichtung startet danach wieder von vorn</strong>. Zusätzlich zu Stufe 1 fallen:
        </p>
        <ul>
          <li>
            alle selbst gebauten <strong>Prozessversionen und Entwürfe</strong> (der Auslieferungsstand
            aus den Migrationen bleibt), dazu eigene Felder und abgeschaltete Schritte
          </li>
          <li>die Paketwahl — die Navigation zeigt danach wieder alle Prozesse</li>
          <li>alle <strong>Benutzerkonten außer dem eigenen</strong> (sonst käme niemand mehr hinein)</li>
          <li>die Firmendaten (zurück auf den Vorgabewert)</li>
        </ul>
        <p className="muted small">
          Nicht angefasst: technische Konfiguration (DHL-Absender, Freigabe-Limits, Finanz-Quoten,
          Kartonagen, Versandregeln), Lagerorte, Einheiten, Steuern, Zahlungsbedingungen — das ist
          Einrichtung des Betreibers, kein Datenbestand. Und die Registrierungen der Startseite.
        </p>
        <div className="notice danger">
          Härter als Stufe 1 und ebenfalls endgültig. Zur Bestätigung unten exakt{' '}
          <strong>WERKSZUSTAND</strong> eintippen.
        </div>
        <ActionForm action={werkszustandHerstellen}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
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

      <Card title="Nummernkreise" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Beleg</th>
                <th>Präfix</th>
                <th className="num">Nächste Nummer</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((s) => (
                <tr key={s.code}>
                  <td className="mono small">{s.code}</td>
                  <td className="mono">{s.prefix}</td>
                  <td className="num mono">{s.next_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </>
  )
}
