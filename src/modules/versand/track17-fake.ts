import 'server-only'
import type { Abgelehnt, Angemeldet, Kontingent } from './track17'
import type { Track17Eintrag } from './track17-logik'

/**
 * Deterministischer 17TRACK-Ersatz für Prozesstests und Staging
 * (TRACK17_FAKE=1). Getypt gegen die echten Client-Schnittstellen —
 * ändert sich dort eine Signatur, bricht der Fake zur Compile-Zeit.
 *
 * Regeln: Nummern mit „XX" vorn kennt kein Carrier (abgelehnt), Nummern
 * mit „LIMIT" vorn stoßen ans Tageslimit (abgelehnt, wiederholbar). Der
 * Stand richtet sich nach der letzten Stelle der Nummer — 0 nicht
 * gefunden, 1 angekündigt, 2–5 unterwegs, 6 in Zustellung, 7 zugestellt,
 * 8 Problem, 9 abholbereit — oder nach einem hinterlegten Stand
 * (fakeStandSetzen, für Tests und das Webhook-Spiel).
 */

interface FakeStand {
  status: string
  sub_status?: string
  text?: string
  ort?: string
  zeit?: string
}

const STAENDE = new Map<string, FakeStand>()
const ANGEMELDET = new Set<string>()

export function fakeStandSetzen(nummer: string, stand: FakeStand): void {
  STAENDE.set(nummer, stand)
}

export function fakeAngemeldet(nummer: string): boolean {
  return ANGEMELDET.has(nummer)
}

function standFuer(nummer: string): FakeStand {
  const hinterlegt = STAENDE.get(nummer)
  if (hinterlegt) return hinterlegt
  const letzte = nummer.trim().slice(-1)
  switch (letzte) {
    case '0':
      return { status: 'NotFound' }
    case '1':
      return { status: 'InfoReceived', text: 'Sendungsdaten elektronisch übermittelt', ort: 'Shenzhen' }
    case '6':
      return { status: 'OutForDelivery', text: 'In Zustellung', ort: 'Berlin' }
    case '7':
      return { status: 'Delivered', sub_status: 'Delivered_Other', text: 'Zugestellt', ort: 'Berlin' }
    case '8':
      return { status: 'Exception', sub_status: 'Exception_Delayed', text: 'Verzögerung im Transport', ort: 'Frankfurt' }
    case '9':
      return { status: 'AvailableForPickup', text: 'Abholbereit in der Filiale', ort: 'Berlin' }
    default:
      return { status: 'InTransit', sub_status: 'InTransit_Other', text: 'Sendung im Paketzentrum', ort: 'Leipzig' }
  }
}

export function fakeEintrag(nummer: string, carrier: number | null): Track17Eintrag {
  const s = standFuer(nummer)
  const zeit = s.zeit ?? '2026-10-14T22:10:00+02:00'
  const ereignis = s.status === 'NotFound'
    ? null
    : { time_iso: zeit, description: s.text ?? s.status, location: s.ort ?? null, sub_status: s.sub_status ?? null }
  return {
    number: nummer,
    carrier: carrier ?? 7041,
    track_info: {
      latest_status: { status: s.status, sub_status: s.sub_status ?? `${s.status}_Other` },
      latest_event: ereignis,
      tracking: {
        providers: [
          {
            provider: { key: carrier ?? 7041, name: carrier === 100001 ? 'DHL Express' : 'DHL Paket' },
            events: ereignis
              ? [
                  ereignis,
                  { time_iso: '2026-10-13T08:00:00+02:00', description: 'Sendung abgeholt', location: 'Shenzhen', sub_status: 'InTransit_PickedUp' },
                ]
              : [],
          },
        ],
      },
    },
  }
}

export async function fakeNummernAnmelden(
  eintraege: { nummer: string; carrier: number | null }[],
): Promise<{ angemeldet: Angemeldet[]; abgelehnt: Abgelehnt[] }> {
  const angemeldet: Angemeldet[] = []
  const abgelehnt: Abgelehnt[] = []
  for (const e of eintraege) {
    if (e.nummer.startsWith('XX')) {
      abgelehnt.push({ number: e.nummer, carrier: e.carrier, code: -18019903, message: 'Carrier cannot be detected' })
    } else if (e.nummer.startsWith('LIMIT')) {
      abgelehnt.push({ number: e.nummer, carrier: e.carrier, code: -18019907, message: 'Daily limit exceeded' })
    } else if (ANGEMELDET.has(e.nummer)) {
      abgelehnt.push({ number: e.nummer, carrier: e.carrier, code: -18019901, message: 'Already registered' })
    } else {
      ANGEMELDET.add(e.nummer)
      angemeldet.push({ number: e.nummer, carrier: e.carrier ?? 7041 })
    }
  }
  return { angemeldet, abgelehnt }
}

export async function fakeStaendeAbfragen(
  eintraege: { nummer: string; carrier: number | null }[],
): Promise<Map<string, Track17Eintrag>> {
  return new Map(eintraege.map((e) => [e.nummer, fakeEintrag(e.nummer, e.carrier)]))
}

export async function fakeKontingent(): Promise<Kontingent> {
  return { quota_total: 100, quota_used: ANGEMELDET.size, quota_remain: 100 - ANGEMELDET.size, today_used: 0, max_track_daily: 100 }
}
