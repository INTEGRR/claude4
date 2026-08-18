'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { HexcoreMark } from '@/components/marke'
import { DC_EVENTS } from '@/modules/ki/sprechen-katalog'

/**
 * Der Gesprächs-Client: WebRTC direkt zu OpenAI (Audio), Function-Calls über
 * den Datachannel an /api/sprechen/werkzeug, Transkripte gepuffert an
 * /api/sprechen/protokoll. Das Hexcore ist die einzige Zustandsanzeige
 * (hören = pulsierend, sprechen = atmend), darunter läuft das kompakte
 * Live-Log — kurze Zeilen mit Werten, kein Volltranskript.
 *
 * Nach dem Beenden lädt router.refresh() die Seite neu — die gesammelten
 * Vorgänge erscheinen dann als Prüftabelle (gebucht wird NUR dort).
 */

type Zustand = 'aus' | 'verbindet' | 'leerlauf' | 'hoert' | 'denkt' | 'spricht'

interface LogZeile {
  id: number
  art: 'nutzer' | 'assistent' | 'werkzeug' | 'notiert' | 'fehler' | 'info'
  text: string
}

interface FunctionCallEvent {
  type: string
  call_id?: string
  name?: string
  arguments?: string
  transcript?: string
}

const ZUSTAND_TEXT: Record<Zustand, string> = {
  aus: 'Getrennt',
  verbindet: 'Verbinde …',
  leerlauf: 'Bereit — einfach sprechen',
  hoert: 'Hört zu …',
  denkt: 'Denkt nach …',
  spricht: 'Antwortet',
}

let logId = 0

export function Gespraech() {
  const router = useRouter()
  const [zustand, setZustand] = useState<Zustand>('aus')
  const [fehler, setFehler] = useState<string | null>(null)
  const [log, setLog] = useState<LogZeile[]>([])
  const [hosentasche, setHosentasche] = useState(false)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const protokollRef = useRef<string | null>(null)
  const pufferRef = useRef<{ rolle: 'nutzer' | 'assistent'; text: string }[]>([])
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null)
  const logEndeRef = useRef<HTMLDivElement | null>(null)
  const zuletztAktivRef = useRef(0)
  const leerlaufTimerRef = useRef<number | null>(null)

  const zeile = useCallback((art: LogZeile['art'], text: string) => {
    setLog((alt) => [...alt.slice(-60), { id: ++logId, art, text }])
  }, [])

  useEffect(() => {
    logEndeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [log])

  /** Transkript-Puffer an den Server spülen (Batch; sendBeacon beim Schließen). */
  const spuelen = useCallback((beendet: boolean, alsBeacon = false) => {
    const protokollId = protokollRef.current
    if (!protokollId) return
    const eintraege = pufferRef.current.splice(0)
    if (eintraege.length === 0 && !beendet) return
    const body = JSON.stringify({ protokoll_id: protokollId, eintraege, beendet })
    if (alsBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/sprechen/protokoll', new Blob([body], { type: 'application/json' }))
    } else {
      void fetch('/api/sprechen/protokoll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [])

  const trennen = useCallback(
    (mitRefresh: boolean) => {
      if (leerlaufTimerRef.current) {
        window.clearInterval(leerlaufTimerRef.current)
        leerlaufTimerRef.current = null
      }
      dcRef.current?.close()
      dcRef.current = null
      pcRef.current?.close()
      pcRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (audioRef.current) {
        audioRef.current.srcObject = null
        audioRef.current = null
      }
      void wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
      spuelen(true)
      protokollRef.current = null
      setHosentasche(false)
      setZustand('aus')
      if (mitRefresh) router.refresh()
    },
    [router, spuelen],
  )

  // Abriss im Hintergrund: Puffer retten (Seite zu, App gewechselt).
  useEffect(() => {
    const beiPagehide = () => {
      if (protokollRef.current) spuelen(true, true)
    }
    window.addEventListener('pagehide', beiPagehide)
    return () => {
      window.removeEventListener('pagehide', beiPagehide)
      trennen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Function-Call ausführen und Ergebnis über den Datachannel zurückgeben. */
  const werkzeug = useCallback(
    async (ev: FunctionCallEvent) => {
      const name = ev.name ?? ''

      // Verabschiedung: der Client trennt selbst — kein Server-Umweg. Kurze
      // Gnadenfrist, damit das gesprochene "Tschüss" noch zu Ende spielt.
      if (name === 'sitzung_beenden') {
        zeile('info', 'Sitzung wird beendet.')
        window.setTimeout(() => trennen(true), 2500)
        return
      }
      let argumente: unknown = {}
      try {
        argumente = ev.arguments ? JSON.parse(ev.arguments) : {}
      } catch {
        // kaputte Argumente — der Server meldet es als Text
      }
      let output = 'Werkzeug fehlgeschlagen.'
      try {
        const res = await fetch('/api/sprechen/werkzeug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, argumente, protokoll_id: protokollRef.current }),
        })
        const daten = (await res.json()) as { output?: string; error?: string }
        output = daten.output ?? daten.error ?? output
      } catch {
        output = 'Keine Verbindung zum ERP-Server.'
      }

      // Kompaktes Live-Log statt Roh-JSON: die Werte, um die es geht.
      if (name === 'produkt_bestand') {
        try {
          const o = JSON.parse(output) as {
            produkt?: string
            bestand?: number
            kandidaten?: { produkt: string }[]
          }
          if (o.produkt) zeile('werkzeug', `${o.produkt} · Bestand ${o.bestand}`)
          else if (o.kandidaten) {
            zeile('werkzeug', `Mehrdeutig: ${o.kandidaten.map((k) => k.produkt).join(' | ')}`)
          } else zeile('werkzeug', output.slice(0, 120))
        } catch {
          zeile('werkzeug', output.slice(0, 120))
        }
      } else if (name === 'vorgang_sammeln') {
        zeile(output.startsWith('Notiert') ? 'notiert' : 'fehler', output.slice(0, 160))
      } else {
        zeile('werkzeug', `${name}: ${output.slice(0, 120)}`)
      }

      const dc = dcRef.current
      if (dc && dc.readyState === 'open' && ev.call_id) {
        dc.send(
          JSON.stringify({
            type: DC_EVENTS.itemCreate,
            item: { type: 'function_call_output', call_id: ev.call_id, output },
          }),
        )
        dc.send(JSON.stringify({ type: DC_EVENTS.responseCreate }))
      }
    },
    [trennen, zeile],
  )

  const beiEvent = useCallback(
    (roh: MessageEvent<string>) => {
      let ev: FunctionCallEvent
      try {
        ev = JSON.parse(roh.data) as FunctionCallEvent
      } catch {
        return
      }
      zuletztAktivRef.current = Date.now()
      switch (ev.type) {
        case DC_EVENTS.sprichtStart:
          setZustand('hoert')
          break
        case DC_EVENTS.sprichtEnde:
          setZustand('denkt')
          break
        case DC_EVENTS.antwortStart:
          setZustand('spricht')
          break
        case DC_EVENTS.antwortEnde:
          setZustand('leerlauf')
          break
        case DC_EVENTS.nutzerTranskript: {
          const text = (ev.transcript ?? '').trim()
          if (text) {
            pufferRef.current.push({ rolle: 'nutzer', text })
            zeile('nutzer', text.length > 90 ? `${text.slice(0, 90)}…` : text)
            if (pufferRef.current.length >= 10) spuelen(false)
          }
          break
        }
        case DC_EVENTS.assistentTranskript: {
          const text = (ev.transcript ?? '').trim()
          if (text) {
            pufferRef.current.push({ rolle: 'assistent', text })
            zeile('assistent', text.length > 90 ? `${text.slice(0, 90)}…` : text)
          }
          break
        }
        case DC_EVENTS.functionCallDone:
          void werkzeug(ev)
          break
        default:
          break
      }
    },
    [spuelen, werkzeug, zeile],
  )

  const verbinden = useCallback(async () => {
    setFehler(null)
    setZustand('verbindet')
    setLog([])
    try {
      // 1) Sitzung + kurzlebigen Client Secret vom eigenen Server holen.
      const res = await fetch('/api/sprechen/session', { method: 'POST' })
      const daten = (await res.json()) as {
        client_secret?: string
        protokoll_id?: string
        error?: string
      }
      if (!res.ok || !daten.client_secret || !daten.protokoll_id) {
        throw new Error(daten.error ?? 'Sitzungsstart fehlgeschlagen')
      }
      protokollRef.current = daten.protokoll_id

      // 2) Audio-Element in der Klick-Geste erzeugen (iOS-Autoplay).
      const audio = new Audio()
      audio.autoplay = true
      audio.setAttribute('playsinline', 'true')
      audioRef.current = audio

      // 3) WebRTC: Mikrofon rein, Modell-Audio raus, Events über Datachannel.
      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0]
        void audio.play().catch(() => undefined)
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setFehler('Verbindung abgerissen.')
          trennen(true)
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      pc.addTrack(stream.getTracks()[0], stream)

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onmessage = beiEvent

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${daten.client_secret}`,
          'Content-Type': 'application/sdp',
        },
      })
      if (!sdpRes.ok) throw new Error(`Realtime-Verbindung abgelehnt (${sdpRes.status})`)
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() })

      // 4) Schirm anlassen, solange gesprochen wird (Muster KI-Chat).
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
        }
        wakeLockRef.current = (await nav.wakeLock?.request('screen')) ?? null
      } catch {
        wakeLockRef.current = null
      }

      setZustand('leerlauf')
      zeile('info', 'Verbunden — einfach lossprechen.')

      // Leerlauf-Leine: fünf Minuten ohne jedes Datachannel-Event → sauber
      // trennen statt Audio-Tokens im Schweigen zu verbrennen.
      zuletztAktivRef.current = Date.now()
      leerlaufTimerRef.current = window.setInterval(() => {
        if (Date.now() - zuletztAktivRef.current > 5 * 60_000) {
          zeile('info', 'Fünf Minuten Stille — Sitzung beendet.')
          trennen(true)
        }
      }, 30_000)
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Verbindung fehlgeschlagen')
      trennen(false)
    }
  }, [beiEvent, trennen, zeile])

  const aktiv = zustand !== 'aus' && zustand !== 'verbindet'

  // Hosentaschen-Modus: app-seitig abgedunkelt + berührungsgesperrt, das
  // Gespräch läuft weiter (WebRTC-Audio wie ein Telefonat, In-Ears via
  // Bluetooth). Bewusst KEINE echte Bildschirmsperre — iOS würde dabei das
  // Mikrofon kappen; der Wake Lock hält den Schirm, die Abdunkelung spart
  // Augen und verhindert Hosentaschen-Tipper. Doppeltipp entsperrt.
  if (hosentasche && aktiv) {
    return (
      <div
        className="sprechen-hosentasche"
        onDoubleClick={() => setHosentasche(false)}
        role="button"
        aria-label="Hosentaschen-Modus — Doppeltipp zum Entsperren"
      >
        <div className={`sprechen-kern zustand-${zustand}`}>
          <HexcoreMark groesse={72} variante="voll" />
        </div>
        <div className="mono-label" style={{ opacity: 0.5, marginTop: 14 }}>
          Doppeltipp zum Entsperren
        </div>
      </div>
    )
  }

  return (
    <section className="card">
      <div className="body" style={{ textAlign: 'center', padding: '28px 16px 20px' }}>
        {/* Das Hexcore ist die Zustandsanzeige: pulsiert beim Hören,
            atmet beim Antworten — intuitiv statt Statustext-Wüste. */}
        <div className={`sprechen-kern zustand-${zustand}`} aria-live="polite">
          <HexcoreMark groesse={96} variante="voll" />
        </div>
        <div className="mono-label" style={{ marginTop: 10 }}>{ZUSTAND_TEXT[zustand]}</div>

        <div style={{ marginTop: 16 }}>
          {!aktiv ? (
            <button
              className="primary"
              onClick={() => void verbinden()}
              disabled={zustand === 'verbindet'}
              style={{ minWidth: 200 }}
            >
              {zustand === 'verbindet' ? 'Verbinde …' : 'Verbinden'}
            </button>
          ) : (
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <button className="wichtig" onClick={() => trennen(true)} style={{ minWidth: 170 }}>
                Beenden &amp; prüfen
              </button>
              <button onClick={() => setHosentasche(true)} title="Bildschirm abdunkeln und sperren — das Gespräch läuft weiter (In-Ears)">
                Hosentasche
              </button>
            </span>
          )}
        </div>
        {fehler && (
          <div className="notice danger" role="alert" style={{ marginTop: 12, display: 'inline-block' }}>
            <span className="led warn" style={{ marginRight: 6 }} />
            {fehler}{' '}
            <button className="small" onClick={() => void verbinden()} style={{ marginLeft: 8 }}>
              Neu verbinden
            </button>
          </div>
        )}

        {/* Kompaktes Live-Log: Themen und Werte, keine Textwüste. */}
        {log.length > 0 && (
          <div className="sprechen-log" role="log">
            {log.map((z) => (
              <div key={z.id} className={`sprechen-log-zeile art-${z.art}`}>
                {z.art === 'notiert' && <span className="led wichtig" />}
                {z.art === 'werkzeug' && <span className="led ok" />}
                {z.art === 'fehler' && <span className="led warn" />}
                <span className={z.art === 'nutzer' || z.art === 'assistent' ? 'muted' : 'mono'}>
                  {z.art === 'nutzer' ? '» ' : ''}
                  {z.text}
                </span>
              </div>
            ))}
            <div ref={logEndeRef} />
          </div>
        )}
      </div>
    </section>
  )
}
