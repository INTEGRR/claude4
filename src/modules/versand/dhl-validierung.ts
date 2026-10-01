/**
 * DHL-Adressprüfung und lesbare DHL-Meldungen — der rechnende Teil ohne Netz
 * und ohne Datenbank, damit er sich direkt testen lässt
 * (tests/dhl-validierung.test.ts). Der Aufruf selbst lebt in dhl.ts.
 *
 * Hintergrund: Die Parcel DE Shipping API v2 prüft eine Sendung mit
 * `POST /orders?validate=true` vollständig — samt Adresse —, ohne ein Label
 * zu erzeugen. Je Sendung kommt ein Status (`sstatus`) und eine Liste
 * `validationMessages` mit Feld (`property`), Text und Schwere
 * (`validationState`: Error = so lehnt DHL das Label ab, Warning = Label
 * ginge, die Adresse ist aber z. B. nicht leitcodierbar — das kostet
 * Nachcodierungs-Entgelt). Dieselben Meldungen kommen beim echten Labeldruck;
 * dort waren sie bisher nur als „consignee.postalCode: …" zu lesen.
 */

export interface DhlValidierungsMeldung {
  property?: string
  validationMessage?: string
  validationState?: string
}

export interface DhlAntwortItem {
  shipmentNo?: string
  sstatus?: { title?: string; statusCode?: number; detail?: string }
  validationMessages?: DhlValidierungsMeldung[]
  label?: { b64?: string; url?: string }
}

/** Antwort von POST /orders — Fehler kommen verschachtelt (status) ODER flach (title/detail). */
export interface DhlAntwort {
  status?: { title?: string; statusCode?: number; detail?: string }
  title?: string
  detail?: string
  items?: DhlAntwortItem[]
}

/** Ergebnis einer Adressprüfung: ok nur, wenn DHL weder Fehler noch Hinweise meldet. */
export interface AdressPruefung {
  ok: boolean
  /** So lehnt DHL das Label ab (validationState Error). */
  fehler: string[]
  /** Label ginge durch, aber DHL hat etwas zu beanstanden (validationState Warning). */
  hinweise: string[]
}

// --- Felder ------------------------------------------------------------------

/** DHL-Feldnamen (letztes Pfadsegment) → Klartext. */
const FELDER: Record<string, string> = {
  name1: 'Name',
  name2: 'Namenszusatz',
  name3: 'Namenszusatz',
  addressStreet: 'Straße',
  addressHouse: 'Hausnummer',
  additionalAddressInformation1: 'Adresszusatz',
  additionalAddressInformation2: 'Adresszusatz',
  postalCode: 'PLZ',
  city: 'Ort',
  country: 'Land',
  state: 'Bundesland',
  email: 'E-Mail',
  phone: 'Telefon',
  contactName: 'Kontaktperson',
  lockerID: 'Packstation',
  postNumber: 'Postnummer',
  weight: 'Gewicht',
  billingNumber: 'Abrechnungsnummer',
  product: 'DHL-Produkt',
  refNo: 'Referenz',
  shipDate: 'Versanddatum',
  hsCode: 'HS-Code',
  customs: 'Zolldaten',
}

/** Woran man erkennt, dass ein deutscher Text das Feld schon nennt. */
const NENNT_FELD: Record<string, RegExp> = {
  Name: /name/i,
  Straße: /stra(ß|ss)e/i,
  Hausnummer: /hausn(umme)?r/i,
  PLZ: /\bplz\b|postleitzahl/i,
  Ort: /\bort\b|\bstadt\b/i,
  Land: /\bland\b/i,
  'E-Mail': /e-?mail/i,
  Telefon: /telefon/i,
  Gewicht: /gewicht/i,
}

interface Feld {
  /** Klartext des Feldes, z. B. „PLZ" — null, wenn DHL keins nennt oder es unbekannt ist. */
  name: string | null
  /** Absender statt Empfänger — der Empfänger ist der Normalfall und bleibt ungenannt. */
  absender: boolean
}

/**
 * Liest den DHL-Feldpfad: „shipments[0].consignee.postalCode",
 * „consignee.addressHouse" oder „$.shipments[0].shipper.city".
 */
export function feldAus(property: string | undefined): Feld {
  if (!property) return { name: null, absender: false }
  const teile = property
    .replace(/^\$\.?/, '')
    .split('.')
    .map((t) => t.replace(/\[\d+\]$/, ''))
    .filter(Boolean)
  const absender = teile.includes('shipper')
  for (let i = teile.length - 1; i >= 0; i--) {
    const name = FELDER[teile[i]]
    if (name) return { name, absender }
  }
  return { name: null, absender }
}

// --- Meldungen in Klartext -----------------------------------------------------

const PLZ_WORT = /postal\s*code|post\s*code|\bzip\b/i
const ORT_WORT = /\bcity\b|\btown\b/i
const FEHLT_WORT = /missing|required|mandatory|empty|blank|null|not (been )?(provided|specified|given)/i

/** Englische DHL-Texte (ohne Accept-Language) → kurzes Deutsch. Reihenfolge zählt. */
const REGELN: { trifft: (text: string, feld: string | null) => boolean; text: (feld: string | null) => string }[] = [
  {
    trifft: (t, f) => (/house\s*(number|no)/i.test(t) || f === 'Hausnummer') && FEHLT_WORT.test(t),
    text: () => 'Hausnummer fehlt',
  },
  {
    trifft: (t) =>
      PLZ_WORT.test(t) && ORT_WORT.test(t) &&
      /not match|does ?n[o']t (match|fit|correspond|belong)|inconsistent|not valid for|unknown/i.test(t),
    text: () => 'PLZ passt nicht zum Ort',
  },
  {
    trifft: (t, f) =>
      (PLZ_WORT.test(t) || f === 'PLZ') &&
      /invalid|not valid|must match|pattern|format|digits|wrong|incorrect|unknown|(does not|doesn't) exist|not (be )?found/i.test(t),
    text: () => 'PLZ ungültig',
  },
  {
    trifft: (t, f) =>
      (/\bstreet\b/i.test(t) || f === 'Straße') &&
      /not (be )?found|unknown|could not be (found|identified|verified)|(does not|doesn't) exist|invalid/i.test(t),
    text: () => 'Straße nicht gefunden',
  },
  {
    trifft: (t, f) =>
      (ORT_WORT.test(t) || f === 'Ort') && /not (be )?found|unknown|invalid|(does not|doesn't) exist/i.test(t),
    text: () => 'Ort nicht gefunden',
  },
  {
    trifft: (t) => /rout(e|ing|able)|leitcod|cannot be (en)?coded|could not be (en)?coded|not (en)?codable/i.test(t),
    text: () => 'Adresse nicht leitcodierbar — DHL berechnet Nachcodierungs-Entgelt',
  },
  {
    trifft: (t, f) => f !== null && FEHLT_WORT.test(t),
    text: (f) => `${f} fehlt`,
  },
]

const LAENGE = /(?:size|length) must be between (\d+) and (\d+)|must be between (\d+) and (\d+) characters/i

/** Sieht nach deutschem Text aus (DHL antwortet mit Accept-Language de-DE auf Deutsch)? */
function istDeutsch(text: string): boolean {
  return /[äöüß]|\b(der|die|das|ist|nicht|fehlt|bitte|ungültig|unbekannt|kein|keine|und|für|wurde)\b/i.test(text)
}

/**
 * Eine DHL-Meldung als kurzer deutscher Satz: deutscher Text bleibt (mit
 * Feldname davor, wenn er ihn nicht selbst nennt), bekannte englische Texte
 * werden übersetzt, Unbekanntes behält den DHL-Text hinter dem Feldnamen.
 * Meldungen zum Absender bekommen „Absender:" davor — die stammen aus den
 * Firmendaten, nicht aus dem Auftrag.
 */
export function meldungLesbar(m: DhlValidierungsMeldung): string {
  const text = (m.validationMessage ?? '').trim().replace(/\s+/g, ' ')
  const feld = feldAus(m.property)
  const vor = feld.absender ? 'Absender: ' : ''

  if (!text) return `${vor}${feld.name ?? 'Adresse'} beanstandet`
  if (istDeutsch(text)) {
    const nennt = feld.name ? (NENNT_FELD[feld.name]?.test(text) ?? false) : true
    return `${vor}${nennt ? '' : `${feld.name}: `}${text.replace(/\.$/, '')}`
  }
  for (const regel of REGELN) {
    if (regel.trifft(text, feld.name)) return `${vor}${regel.text(feld.name)}`
  }
  const laenge = text.match(LAENGE)
  if (laenge && feld.name) {
    const [von, bis] = laenge[1] ? [laenge[1], laenge[2]] : [laenge[3], laenge[4]]
    return `${vor}${feld.name}: ${von}–${bis} Zeichen erlaubt`
  }
  return `${vor}${feld.name ? `${feld.name}: ` : ''}${text.replace(/\.$/, '')}`
}

const eindeutig = (liste: string[]) => [...new Set(liste.filter(Boolean))]

/** Weiche Hinweise einer erfolgreichen Sendung (Label erstellt) in Klartext. */
export function warnungenLesbar(item: DhlAntwortItem | undefined): string[] {
  return eindeutig((item?.validationMessages ?? []).map(meldungLesbar))
}

// --- Antworten auswerten ---------------------------------------------------------

/**
 * Wertet die Antwort auf POST /orders (mit oder ohne validate=true) aus.
 * null heißt: keine Aussage über die Sendung möglich (Anmeldung, Rechte,
 * Limit, DHL gestört) — das ist ein technischer Fehler, keine Beanstandung.
 */
export function pruefAntwortAuswerten(status: number, json: DhlAntwort | null): AdressPruefung | null {
  if (status === 401 || status === 403 || status === 404 || status === 429 || status >= 500) return null
  const fehler: string[] = []
  const hinweise: string[] = []
  const items = json?.items ?? []

  for (const item of items) {
    const itemFehlerhaft = (item.sstatus?.statusCode ?? 0) >= 400 || (status >= 400 && items.length === 1)
    const meldungen = item.validationMessages ?? []
    for (const m of meldungen) {
      const schwere = (m.validationState ?? '').toLowerCase()
      const istFehler = schwere === 'error' || (schwere !== 'warning' && itemFehlerhaft)
      ;(istFehler ? fehler : hinweise).push(meldungLesbar(m))
    }
    if (meldungen.length === 0 && itemFehlerhaft) {
      fehler.push(meldungLesbar({ validationMessage: item.sstatus?.detail ?? item.sstatus?.title }))
    }
  }

  // Abgelehnt ohne verwertbare Einzelmeldung (z. B. Schemafehler der API-Schicht).
  if (status >= 400 && fehler.length === 0) {
    const kopf = json?.status?.detail ?? json?.detail ?? json?.status?.title ?? json?.title
    fehler.push(kopf ? meldungLesbar({ validationMessage: kopf }) : 'DHL lehnt die Sendung ohne Begründung ab')
  }

  const f = eindeutig(fehler)
  const h = eindeutig(hinweise).filter((x) => !f.includes(x))
  return { ok: f.length === 0 && h.length === 0, fehler: f, hinweise: h }
}

/**
 * Fehlermeldung, wenn DHL ein Label ablehnt — die Gründe stehen in den
 * validationMessages der Sendung; die Kopfzeile („0 of 1 shipment
 * successfully printed") sagt nichts und ist nur der Rückfall.
 */
export function ablehnungsText(status: number, json: DhlAntwort | null): string {
  const p = pruefAntwortAuswerten(status, json)
  const gruende = p ? [...p.fehler, ...p.hinweise] : []
  const kopf = json?.status?.detail ?? json?.status?.title ?? json?.detail ?? json?.title
  const code = status === 400 ? '' : ` (HTTP ${status})`
  return `DHL lehnt die Sendung ab${code}: ${gruende.join(' · ') || kopf || 'unbekannter Fehler'}`
}

// --- Ergebnistext und Vorprüfung ---------------------------------------------------

export interface AdressFelder {
  name: string
  street: string
  houseNumber: string
  zip: string
  city: string
  countryAlpha2: string
}

/** Pflichtfelder vor jedem DHL-Aufruf — was fehlt, als Klartext-Liste. */
export function fehlendeAdressfelder(a: AdressFelder): string[] {
  return (
    [
      ['Name', a.name],
      ['Straße', a.street],
      ['PLZ', a.zip],
      ['Ort', a.city],
    ] as const
  )
    .filter(([, wert]) => !wert?.trim())
    .map(([feld]) => feld)
}

/** Die Adresse in einer Zeile — damit das Ergebnis sagt, WAS geprüft wurde. */
export function adresseEinzeilig(a: AdressFelder): string {
  const strasse = [a.street, a.houseNumber].filter((x) => x?.trim()).join(' ')
  const ort = [a.zip, a.city].filter((x) => x?.trim()).join(' ')
  return [a.name, strasse, ort, a.countryAlpha2].filter((x) => x?.trim()).join(', ')
}

/** Ergebnis der Aktion „Adresse prüfen" in einem Satz. */
export function pruefText(p: AdressPruefung, adresse: string): string {
  if (p.ok) return `Adresse ok — DHL hat nichts zu beanstanden (${adresse}).`
  if (p.fehler.length > 0) {
    const ausserdem = p.hinweise.length ? ` Außerdem: ${p.hinweise.join(' · ')}.` : ''
    return `DHL beanstandet die Adresse: ${p.fehler.join(' · ')} — so lehnt DHL das Label ab (${adresse}).${ausserdem}`
  }
  return (
    `DHL hat Hinweise zur Adresse: ${p.hinweise.join(' · ')} — das Label ginge durch, ` +
    `kann aber Nachcodierungs-Entgelt kosten (${adresse}).`
  )
}

// --- Fake (DHL_FAKE=1) ---------------------------------------------------------------

/**
 * Die Regeln des DHL-Fakes, als DHL-Rohmeldungen: eine deutsche PLZ hat fünf
 * Ziffern (sonst Fehler — auch der Fake-Labeldruck lehnt ab), eine deutsche
 * Adresse ohne Hausnummer ist nicht leitcodierbar (Hinweis — Label geht,
 * kostet aber Nachcodierung). Alles andere gilt als in Ordnung.
 */
export function fakePruefMeldungen(empfaenger: {
  houseNumber: string
  zip: string
  /** ISO alpha-3 wie im DHL-Aufruf. */
  country: string
}): DhlValidierungsMeldung[] {
  if (empfaenger.country !== 'DEU') return []
  const meldungen: DhlValidierungsMeldung[] = []
  const plz = empfaenger.zip.trim()
  if (!/^\d{5}$/.test(plz)) {
    meldungen.push({
      property: 'shipments[0].consignee.postalCode',
      validationMessage: `PLZ „${plz}" ist ungültig — in Deutschland hat die PLZ fünf Ziffern.`,
      validationState: 'Error',
    })
  }
  if (!empfaenger.houseNumber.trim()) {
    meldungen.push({
      property: 'shipments[0].consignee.addressHouse',
      validationMessage: 'Hausnummer fehlt — so ist die Adresse nicht leitcodierbar.',
      validationState: 'Warning',
    })
  }
  return meldungen
}

/** Die Antwort, die DHL auf diese Meldungen gäbe (200 = gültig, 400 = abgelehnt). */
export function fakeAntwort(meldungen: DhlValidierungsMeldung[]): { status: number; json: DhlAntwort } {
  const abgelehnt = meldungen.some((m) => m.validationState === 'Error')
  const status = abgelehnt ? 400 : 200
  return {
    status,
    json: {
      status: { title: abgelehnt ? 'Bad Request' : 'OK', statusCode: status },
      items: [
        {
          sstatus: { title: abgelehnt ? 'Bad Request' : 'OK', statusCode: status },
          validationMessages: meldungen,
        },
      ],
    },
  }
}
