import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, TableWrap, Zustand } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { einstellung } from '@/modules/einstellungen/lesen'
import { ANBINDUNGEN, type AnbindungsStand, anbindungsStand } from '@/modules/einstellungen/umgebung'
import { type DienstStatus, dienstStatusLesen } from '@/modules/integrationen/wache'
import { dateTime, qty } from '@/modules/shared/format'
import { madeToOrderEinstellung, madeToOrderVorschau } from '@/modules/integrationen/made-to-order'
import { POSTFACH_SCHLUESSEL, type PostfachStand } from '@/modules/einkauf/postfach-abgleich'
import { postfachKonfiguriert } from '@/modules/google/auth'

export const dynamic = 'force-dynamic'

/**
 * Einstellungen → Schnittstellen: je Anbindung, ob die Zugangsdaten gesetzt
 * sind (nur Namen, nie Werte), was der Dienste-Wächter zuletzt gesehen hat,
 * das zugehörige Verhalten (Shopify lesen/schreiben, Webhooks) und die
 * Einrichtungshinweise. Der BETRIEB (Outbox, Webhooks, Protokoll, Abgleich)
 * bleibt im Ereignis-Monitor. Entscheidungslog 2026-09-26.
 */

async function shopifyModusSpeichern(formData: FormData) {
  'use server'
  // Registry-Aktion, damit der Wechsel auditiert ist (wer hat wann scharf geschaltet).
  return serverAktion('einstellungen.shopify_modus_setzen', { formData })
}

async function madeToOrderSpeichern(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.shopify_mto_setzen', { formData })
}

async function einkaufsablageEinrichten() {
  'use server'
  return serverAktion('einkauf.ablage_einrichten', {})
}

async function einkaufspostfachAbgleichen() {
  'use server'
  return serverAktion('integrationen.postfach_abgleichen', {})
}

async function webhooksRegistrieren(formData: FormData) {
  'use server'
  return serverAktion('integrationen.webhooks_registrieren', { formData })
}

/** Fehlende Pflichtwerte sind nur hier ein Problem — der Rest ist optional. */
const KRITISCH = new Set(['shopify', 'dhl', 'system'])

function Stand({ stand, wache: wacheRoh }: { stand: AnbindungsStand; wache?: DienstStatus }) {
  const a = stand.anbindung
  // Der Wächter-Befund zählt nur für eine konfigurierte Anbindung — sonst
  // stammt er aus einer früheren Konfiguration und widerspräche dem Stand.
  const wache = stand.vollstaendig ? wacheRoh : undefined
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 10 }}>
      {stand.fake ? (
        <Zustand ton="on">Attrappe aktiv ({a.fake}=1) — nichts geht wirklich hinaus</Zustand>
      ) : stand.vollstaendig ? (
        <Zustand ton="ok">konfiguriert</Zustand>
      ) : (
        <Zustand ton={KRITISCH.has(a.schluessel) ? 'warn' : 'off'}>
          nicht konfiguriert — es fehlt {stand.fehlend.join(', ')}
        </Zustand>
      )}
      {wache && wache.status === 'ok' && (
        <Zustand ton="ok">
          erreichbar · {wache.dauer_ms ?? 0} ms · geprüft {wache.geprueft_at ? dateTime(wache.geprueft_at) : '—'}
        </Zustand>
      )}
      {wache && wache.status === 'gestoert' && (
        <Zustand ton="warn">
          gestört seit {wache.seit ? dateTime(wache.seit) : '—'} — {wache.fehler}
        </Zustand>
      )}
    </div>
  )
}

function Variablen({ stand }: { stand: AnbindungsStand }) {
  return (
    <details open={!stand.vollstaendig && KRITISCH.has(stand.anbindung.schluessel)} style={{ marginTop: 10 }}>
      <summary className="small" style={{ cursor: 'pointer' }}>
        Umgebungsvariablen ({stand.variablen.filter((v) => v.gesetzt).length} von {stand.variablen.length} gesetzt)
      </summary>
      <table className="small" style={{ marginTop: 6 }}>
        <tbody>
          {stand.variablen.map((v) => (
            <tr key={v.name}>
              <td style={{ width: 24 }}>
                <span className={`led ${v.gesetzt ? 'ok' : v.pflicht ? 'warn' : 'off'}`} />
              </td>
              <td className="mono nowrap">{v.name}</td>
              <td className="muted">
                {v.pflicht ? '' : 'optional · '}
                {v.zweck}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Gesetzt werden die Werte in Vercel (Project → Settings → Environment Variables) bzw. in der
        Datei <span className="mono">.env</span>; wirksam nach dem nächsten Deploy bzw. Neustart. Vorlage:{' '}
        <span className="mono">.env.example</span>.
      </p>
    </details>
  )
}

export default async function SchnittstellenPage() {
  await requireArea('einstellungen')
  const shopify = await einstellung<{ modus: string }>('shopify')
  const postfach = await einstellung<PostfachStand>(POSTFACH_SCHLUESSEL)
  const modus = shopify.modus === 'schreiben' ? 'schreiben' : 'lesen'
  const [mto, mtoZeilen] = await Promise.all([madeToOrderEinstellung(), madeToOrderVorschau()])
  const mtoAus = mtoZeilen.filter((z) => z.soll <= 0).length
  const mtoKnapp = mtoZeilen.filter((z) => z.soll > 0 && z.baubar < 10).length
  const mtoEingerichtet = mtoZeilen.filter((z) => z.eingerichtet).length
  const engpaesse = [
    ...mtoZeilen
      .reduce((m, z) => {
        if (!z.engpass) return m
        const e = m.get(z.engpass) ?? { varianten: 0, baubar: Infinity }
        m.set(z.engpass, { varianten: e.varianten + 1, baubar: Math.min(e.baubar, z.baubar) })
        return m
      }, new Map<string, { varianten: number; baubar: number }>())
      .entries(),
  ]
    .sort((a, b) => a[1].baubar - b[1].baubar)
    .slice(0, 6)
  const wache = Object.fromEntries((await dienstStatusLesen(sql)).map((d) => [d.dienst, d])) as Record<
    string,
    DienstStatus | undefined
  >
  const stand = Object.fromEntries(ANBINDUNGEN.map((a) => [a.schluessel, anbindungsStand(a)])) as Record<
    (typeof ANBINDUNGEN)[number]['schluessel'],
    AnbindungsStand
  >

  // Bei Shopify registrierte Webhooks — best effort, die Seite darf nicht an
  // einem Netzfehler scheitern (im Fake-Betrieb gibt es keine).
  let webhooks: { topic: string; callbackUrl: string | null }[] | null = null
  if (stand.shopify.vollstaendig && !stand.shopify.fake) {
    try {
      const { fetchWebhooks } = await import('@/modules/integrationen/shopify')
      webhooks = await fetchWebhooks()
    } catch {
      webhooks = null
    }
  }

  return (
    <>
      <EinstellungenKopf
        href="/einstellungen/anbindungen"
        actions={<Link className="btn" href="/integrationen">Ereignis-Monitor</Link>}
      />

      <Card title="Shopify">
        <Stand stand={stand.shopify} wache={wache.shopify} />
        <ActionForm action={shopifyModusSpeichern}>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend className="mono-label" style={{ marginBottom: 8 }}>Lesen oder schreiben</legend>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
              <input type="radio" name="modus" value="lesen" defaultChecked={modus === 'lesen'} />
              <span>
                <strong>Nur lesen (Staging)</strong> — Bestellungen, Kunden und Produkte kommen herein;
                Fulfillments, Tracking, Bestände, Produktänderungen und Webhook-Registrierung gehen
                nicht hinaus. Der Shop bleibt beim Altsystem.
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="radio" name="modus" value="schreiben" defaultChecked={modus === 'schreiben'} />
              <span>
                <strong>Schreiben (scharf)</strong> — KRNL meldet Fulfillments mit Tracking, Bestände
                und Produkte an den Shop zurück. Ab dem Stichtag.
              </span>
            </label>
          </fieldset>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
        <p className="small muted" style={{ margin: '10px 0 16px' }}>
          Gilt sofort. Schreibjobs aus der Lesezeit werden als „übersprungen" abgehakt und laufen
          nicht nach — nach dem Scharfschalten einmal im Ereignis-Monitor „Mit Shopify abgleichen"
          (Bestand) und unten die Webhooks registrieren.
        </p>

        <div className="mono-label" style={{ marginBottom: 6 }}>Sofortmeldung (Webhooks)</div>
        {!stand.shopify.vollstaendig ? (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Erst nach der Einrichtung möglich.</p>
        ) : stand.shopify.fake ? (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Im Fake-Betrieb gibt es keine Webhooks.</p>
        ) : webhooks === null ? (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Registrierte Webhooks konnten nicht abgerufen werden.</p>
        ) : webhooks.length === 0 ? (
          <p className="small" style={{ margin: '0 0 8px' }}>
            <Zustand ton="warn">keine registriert — Änderungen kommen nur über den viertelstündlichen Abgleich</Zustand>
          </p>
        ) : (
          <ul className="small mono" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {webhooks.map((w) => (
              <li key={w.topic}>
                {w.topic.toLowerCase()} → {w.callbackUrl ?? '—'}
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={webhooksRegistrieren}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Öffentliche Adresse des ERP</span>
              <input type="url" name="url" placeholder="https://erp.example.com" defaultValue={process.env.ERP_PUBLIC_URL ?? ''} />
            </label>
            <div className="shrink field">
              <button type="submit" disabled={!stand.shopify.vollstaendig || stand.shopify.fake}>
                Webhooks registrieren
              </button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Mit Webhooks landen Bestellungen, Stornos/Erstattungen und Bestandsänderungen sekundenschnell
          im ERP (Ziel <span className="mono">/api/webhooks/shopify</span>); der Abgleich bleibt Sicherheitsnetz.
          Braucht eine öffentliche https-Adresse und den Modus „schreiben". Produkte werden über die SKU
          zugeordnet — die SKU der Variante muss der Shopify-SKU entsprechen.
        </p>
        <Variablen stand={stand.shopify} />
        <details style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>App im Shop einrichten</summary>
          <p className="small" style={{ margin: '6px 0 0' }}>
            App im <a href="https://dev.shopify.com" target="_blank" rel="noreferrer">Dev Dashboard</a> anlegen,
            Scopes geben (<span className="mono">read_orders</span> — liefert die letzten 60 Tage, ältere
            Bestellungen über <a href="/integrationen/historie">Historie aus Shopify</a> —,{' '}
            <span className="mono">write_orders</span>,{' '}
            <span className="mono">read_customers</span>, <span className="mono">read_products</span>,{' '}
            <span className="mono">write_products</span> (Produkte anlegen, Made-to-Order einrichten),{' '}
            <span className="mono">write_merchant_managed_fulfillment_orders</span>,{' '}
            <span className="mono">read_inventory</span>, <span className="mono">write_inventory</span>,{' '}
            <span className="mono">read_locations</span>) und im eigenen Shop installieren. Client ID und
            Secret stehen unter Settings → Credentials; das Access Token holt das ERP selbst.
          </p>
        </details>
      </Card>

      <Card title="Made-to-Order an Shopify (Tastaturen)">
        <p className="small" style={{ marginTop: 0 }}>
          Artikel mit Route „Fertigen + Auf Auftrag" haben nie Lagerbestand. Shopify bekommt für sie die{' '}
          <strong>baubare Menge</strong>: was das freie Material laut Stückliste noch hergibt (offene Aufträge sind
          eingerechnet — ihre Fertigungsaufträge reservieren die Teile). Fehlt ein Teil, ist die Variante
          ausverkauft. Abgeglichen wird nach jeder Shopify-Bestellung sofort, Änderungen in KRNL binnen einer
          Minute. Beim ersten Abgleich stellt KRNL die Varianten in Shopify auf „Menge verfolgen" und „nicht ohne
          Bestand verkaufen".
        </p>
        <ActionForm action={madeToOrderSpeichern}>
          <div className="row">
            <label className="field">
              <span>Meldung</span>
              <select name="modus" defaultValue={mto.modus}>
                <option value="baubar">baubare Menge − Puffer (höchstens Deckel)</option>
                <option value="fest">fest der Deckel, solange mehr als der Puffer baubar ist</option>
              </select>
            </label>
            <label className="field shrink">
              <span>Puffer</span>
              <input name="puffer" type="number" min={0} max={100} defaultValue={mto.puffer} style={{ width: 90 }} />
            </label>
            <label className="field shrink">
              <span>Deckel</span>
              <input name="deckel" type="number" min={1} max={10000} defaultValue={mto.deckel} style={{ width: 90 }} />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 12px' }}>
          Der Puffer fängt die Sekunden zwischen Bestellung und Abgleich ab — für Releases und Aktionen
          gern höher stellen. „baubar" ist sicherer als „fest": Shopify zieht bei jeder Bestellung selbst ab und
          stoppt bei 0, auch bevor KRNL neu gemeldet hat.
        </p>
        {mtoZeilen.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>Keine Shopify-gekoppelten Made-to-Order-Artikel.</p>
        ) : (
          <>
            <p className="small" style={{ margin: '0 0 8px' }}>
              <strong>{qty(mtoZeilen.length)}</strong> Varianten · <strong>{qty(mtoAus)}</strong> ausverkauft ·{' '}
              <strong>{qty(mtoKnapp)}</strong> knapp (unter 10 baubar) · in Shopify eingerichtet:{' '}
              {qty(mtoEingerichtet)} von {qty(mtoZeilen.length)}
              {modus !== 'schreiben' && ' · Shopify steht auf „nur lesen" — gemeldet wird erst nach dem Umschalten'}
            </p>
            {engpaesse.length > 0 && (
              <p className="small" style={{ margin: '0 0 8px' }}>
                Engpässe:{' '}
                {engpaesse
                  .map(([teil, e]) => `${teil.replace(/^\[[^\]]*\]\s*/, '')} (reicht für ${qty(e.baubar)}, ${qty(e.varianten)} Variante(n))`)
                  .join(' · ')}
              </p>
            )}
            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>Vorschau: was Shopify bekommt (knappste zuerst)</summary>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Variante</th>
                      <th className="num">baubar</th>
                      <th>Engpass</th>
                      <th className="num">an Shopify</th>
                      <th className="num">zuletzt gemeldet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mtoZeilen.slice(0, 40).map((z) => (
                      <tr key={z.id}>
                        <td className="small">
                          {z.name}
                          {z.sku && <span className="muted mono"> · {z.sku}</span>}
                        </td>
                        <td className="num mono">{qty(z.baubar)}</td>
                        <td className="small">{z.engpass?.replace(/^\[[^\]]*\]\s*/, '') ?? '—'}</td>
                        <td className="num mono">{z.soll <= 0 ? <Zustand ton="warn">ausverkauft</Zustand> : qty(z.soll)}</td>
                        <td className="num mono">{z.gemeldet === null ? '—' : qty(z.gemeldet)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {mtoZeilen.length > 40 && (
                <p className="small muted" style={{ margin: '6px 0 0' }}>… und {qty(mtoZeilen.length - 40)} weitere mit mehr Material.</p>
              )}
            </details>
          </>
        )}
      </Card>

      <Card title="DHL Parcel DE" actions={<Link className="btn small" href="/einstellungen/versand">Labelformat &amp; Druckweg</Link>}>
        <Stand stand={stand.dhl} wache={wache.dhl} />
        <p className="small muted" style={{ margin: 0 }}>
          Versand, Retouren und Sendungsverfolgung über die Parcel-DE-APIs. Das Passwort des
          GKP-Systembenutzers läuft nach 365 Tagen ab — dann meldet der Dienste-Wächter eine
          Störung. Welches Produkt eine Sendung bekommt, regeln die{' '}
          <Link href="/einstellungen/versandregeln">Versandregeln</Link>.
        </p>
        <Variablen stand={stand.dhl} />
      </Card>

      <div className="grid-2">
        <Card title="E-Mail (Resend)">
          <Stand stand={stand.mail} wache={wache.mail} />
          <p className="small muted" style={{ margin: 0 }}>
            Bestellungen an Lieferanten, Retourenlabels, Eingangsbestätigungen. Ohne Schlüssel werden
            Mails nur protokolliert, nicht versendet.
          </p>
          <Variablen stand={stand.mail} />
        </Card>

        <Card title="Telegram" actions={<Link className="btn small" href="/einstellungen/benachrichtigungen">Benachrichtigungen</Link>}>
          <Stand stand={stand.telegram} wache={wache.telegram} />
          <p className="small muted" style={{ margin: 0 }}>
            Push-Nachrichten an den Betreiber: Anmeldungen, Fehlversuche, gescheiterte Jobs, Störungen.
          </p>
          <Variablen stand={stand.telegram} />
        </Card>

        <Card title="KI (Anthropic)" actions={<Link className="btn small" href="/einstellungen/ki">KI-Modelle</Link>}>
          <Stand stand={stand.ki} wache={wache.ki} />
          <p className="small muted" style={{ margin: 0 }}>
            KI-Analyse, Prozess-Aufnahme und Interview. Ohne Schlüssel ist die KI aus; alle anderen
            Module laufen unabhängig davon.
          </p>
          <Variablen stand={stand.ki} />
        </Card>

        <Card title="Sprache (OpenAI)">
          <Stand stand={stand.sprache} wache={wache.sprache} />
          <p className="small muted" style={{ margin: 0 }}>
            Spracheingabe und Sprachmodus. Ohne Schlüssel erscheinen keine Mikrofon-Knöpfe — Tippen
            geht immer.
          </p>
          <Variablen stand={stand.sprache} />
        </Card>
      </div>

      <Card title="Odoo (nur lesend)">
        <Stand stand={stand.odoo} />
        <p className="small muted" style={{ margin: 0 }}>
          KRNL liest aus dem laufenden Odoo nur Stücklisten, Komponenten, Lieferanten und Bestände —
          es schreibt nie zurück. Übernahme mit Vorschau:{' '}
          <Link href="/einstellungen/odoo">Odoo-Übernahme</Link>.
        </p>
        <Variablen stand={stand.odoo} />
      </Card>

      <Card title="Google Workspace (Einkauf)">
        <Stand stand={stand.google} wache={wache.google} />
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          Dateien des Einkaufs liegen in der geteilten Ablage „Einkauf" (Ordner je Lieferant, Bestellung
          und Artikel) — KRNL hält nur den Index. Das Dienstkonto braucht dort die Rolle
          Inhaltsmanager; für das Einkaufspostfach zusätzlich die domänenweite Delegation mit nur{' '}
          <code className="mono">gmail.modify</code>. KRNL liest das Postfach jede Minute
          (<Link href="/einkauf/posteingang">Posteingang</Link>)
          {postfach.letzter_lauf ? `, zuletzt ${dateTime(postfach.letzter_lauf)}` : ''}.
        </p>
        <div className="actions">
          <ActionForm action={einkaufsablageEinrichten}>
            <button className="small" type="submit" disabled={!stand.google.vollstaendig && !stand.google.fake}>
              Ablage einrichten (Hauptordner anlegen)
            </button>
          </ActionForm>
          <ActionForm action={einkaufspostfachAbgleichen}>
            <button className="small" type="submit" disabled={!postfachKonfiguriert()}>
              Postfach jetzt abgleichen
            </button>
          </ActionForm>
        </div>
        <Variablen stand={stand.google} />
      </Card>

      <Card title="Betrieb (Zeitsteuerung und Schlüssel)">
        <Stand stand={stand.system} />
        <p className="small muted" style={{ margin: 0 }}>
          Geplante Aufgaben laufen über <span className="mono">/api/cron?task=…</span> (siehe{' '}
          <span className="mono">vercel.json</span>): Webhooks und Jobs samt Telegram-Versand jede
          Minute, Shopify-Abgleich alle 15 Minuten, Dienste-Wächter alle fünf Minuten,
          Sendungsverfolgung stündlich, Aufräumen und Finanz-Tageslauf täglich. Ohne{' '}
          <span className="mono">CRON_SECRET</span> läuft auf Vercel keine davon.
        </p>
        <Variablen stand={stand.system} />
      </Card>
    </>
  )
}
