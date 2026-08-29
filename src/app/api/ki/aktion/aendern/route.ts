import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { type Aktion, AKTIONEN, aktionPruefen } from '@/modules/ki/aktionen'
import { kiConfigured } from '@/modules/ki/agent'
import { kiModell } from '@/modules/ki/modelle'

/**
 * Einen Vorschlag per Zuruf überarbeiten („die Kürzel für Grün auf GN").
 *
 * Bewusst eine eigene, kurze Runde statt eines weiteren Chat-Durchlaufs: das
 * Modell bekommt nur die Aktion und die aktuellen Felder und liefert die
 * vollständigen neuen Felder zurück. Es sieht dabei keine Datenbank und kann
 * nichts ausführen — geprüft wird anschließend gegen dasselbe Schema wie
 * beim Anlegen, und ausgeführt wird weiterhin nur auf Klick.
 */


export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!kiConfigured()) {
    return NextResponse.json({ error: 'Die KI-Analyse ist nicht konfiguriert' }, { status: 400 })
  }

  let name: string
  let parameter: unknown
  let anweisung: string
  try {
    const body = (await request.json()) as {
      aktion?: unknown
      parameter?: unknown
      anweisung?: unknown
    }
    if (typeof body.aktion !== 'string' || typeof body.anweisung !== 'string') throw new Error()
    name = body.aktion
    parameter = body.parameter
    anweisung = body.anweisung.trim()
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }
  if (!anweisung) return NextResponse.json({ error: 'Keine Änderung angegeben' }, { status: 400 })

  // Registry-Aktionen (namespaced) und der eigene KI-Katalog teilen sich den
  // Ablauf — nur Nachschlag, Rechteprüfung und Validierung unterscheiden sich.
  // Die record_id einer Registry-Aktion wird vor dem Umschreiben abgetrennt
  // und danach unverändert wieder angehängt.
  const registry = name.includes('.')
  let label: string
  let beschreibung: string
  let recordId: string | undefined
  let pruefen: (werte: unknown) => { werte: Record<string, unknown>; zusammenfassung: string }

  if (registry) {
    const { registrierteAktion } = await import('@/modules/prozesse/registry')
    const { aktionErlaubt, aktionPruefen: torPruefen } = await import(
      '@/modules/prozesse/torwaechter'
    )
    const eintrag = registrierteAktion(name)
    if (!eintrag) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 })
    if (!aktionErlaubt(eintrag, user.role, user.befugnisse)) {
      return NextResponse.json(
        { error: `Ihrer Rolle fehlt die Berechtigung für „${eintrag.label}"` },
        { status: 403 },
      )
    }
    label = eintrag.label
    beschreibung = eintrag.beschreibung
    const p = (parameter && typeof parameter === 'object' ? parameter : {}) as Record<
      string,
      unknown
    >
    recordId = typeof p.record_id === 'string' ? p.record_id : undefined
    const { record_id: _weg, ...felder } = p
    parameter = felder
    pruefen = (werte) => {
      const geprueft = torPruefen(name, { parameter: werte, recordId })
      return {
        werte: geprueft.werte,
        zusammenfassung:
          eintrag.zusammenfassung?.(geprueft.werte as never) ?? eintrag.label,
      }
    }
  } else {
    const aktion = (AKTIONEN as Record<string, Aktion>)[name]
    if (!aktion) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 })
    // Wer die Aktion nicht ausführen darf, soll sie auch nicht umschreiben.
    if (!canWrite(user.role, aktion.bereich, user.befugnisse)) {
      return NextResponse.json(
        { error: `Ihrer Rolle fehlt die Berechtigung für „${aktion.label}"` },
        { status: 403 },
      )
    }
    label = aktion.label
    beschreibung = aktion.beschreibung
    pruefen = (werte) => {
      const { werte: geprueft } = aktionPruefen(name, werte)
      return { werte: geprueft, zusammenfassung: aktion.zusammenfassung(geprueft) }
    }
  }

  const client = new Anthropic()
  const modell = await kiModell(sql, 'auswertung')
  const anfrage = (hinweis?: string) =>
    client.messages.create({
      model: modell,
      max_tokens: 4000,
      system:
        'Du überarbeitest den Feldsatz eines Aktionsvorschlags in einem ERP. Du bekommst die ' +
        'aktuellen Felder als JSON und eine Änderungsanweisung. Gib über das Werkzeug ' +
        '`felder_ersetzen` den **vollständigen** neuen Feldsatz zurück — nicht nur das ' +
        'Geänderte. Ändere ausschließlich, was die Anweisung verlangt, und erfinde keine ' +
        'Werte dazu.\n\n' +
        `Aktion: ${name} (${label})\n${beschreibung}`,
      tools: [
        {
          name: 'felder_ersetzen',
          description: 'Liefert den vollständigen überarbeiteten Feldsatz.',
          input_schema: {
            type: 'object' as const,
            properties: {
              parameter: { type: 'object', description: 'Die kompletten neuen Felder.' },
              hinweis: {
                type: 'string',
                description: 'Ein Satz, was geändert wurde — wird dem Benutzer angezeigt.',
              },
            },
            required: ['parameter'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'felder_ersetzen' },
      messages: [
        {
          role: 'user',
          content:
            `Aktuelle Felder:\n${JSON.stringify(parameter, null, 2)}\n\n` +
            `Änderung: ${anweisung}` +
            (hinweis ? `\n\nDein letzter Versuch wurde abgelehnt: ${hinweis}` : ''),
        },
      ],
    })

  // Ein Wiederholungsversuch mit der Fehlermeldung: Schemafehler sind für das
  // Modell meist in einem Anlauf behebbar, und der Benutzer soll dafür nicht
  // seine Anweisung neu tippen müssen.
  let letzterFehler = ''
  for (let versuch = 0; versuch < 2; versuch++) {
    let antwort: Anthropic.Messages.Message
    try {
      antwort = await anfrage(versuch > 0 ? letzterFehler : undefined)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Die KI ist nicht erreichbar' },
        { status: 502 },
      )
    }

    const block = antwort.content.find((b) => b.type === 'tool_use')
    if (!block || block.type !== 'tool_use') {
      letzterFehler = 'Es kam kein Feldsatz zurück.'
      continue
    }
    const eingabe = block.input as { parameter?: unknown; hinweis?: string }

    try {
      const { werte, zusammenfassung } = pruefen(eingabe.parameter)
      return NextResponse.json({
        parameter: { ...werte, ...(recordId ? { record_id: recordId } : {}) },
        zusammenfassung,
        hinweis: eingabe.hinweis ?? null,
      })
    } catch (err) {
      letzterFehler = err instanceof Error ? err.message : 'Ungültige Felder'
    }
  }

  return NextResponse.json({ error: letzterFehler }, { status: 400 })
}
