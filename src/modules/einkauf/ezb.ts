/**
 * EZB-Referenzkurse (0097): die Europäische Zentralbank veröffentlicht
 * werktags gegen 16 Uhr die Kurse als XML — „1 EUR = x Fremdwährung".
 * KRNL speichert umgekehrt „1 Fremdwährung = x EUR" (exchange_rates.rate),
 * also 1/Kurs, mit Quelle `ezb`. Von Hand erfasste Kurse (`manuell`)
 * werden nie überschrieben. Dieses Modul ist pur (Lesen des XML); der
 * Abruf mit Speichern steht in ezb-abruf.ts.
 */

export const EZB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

export interface EzbKurse {
  datum: string
  /** Fremdwährung je 1 EUR, wie veröffentlicht. */
  kurse: Record<string, number>
}

export function ezbXmlLesen(xml: string): EzbKurse {
  const datum = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1]
  if (!datum) throw new Error('EZB-Antwort ohne Datum — kein Kurs-XML')
  const kurse: Record<string, number> = {}
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g)) {
    const kurs = Number(m[2])
    if (Number.isFinite(kurs) && kurs > 0) kurse[m[1]] = kurs
  }
  if (Object.keys(kurse).length === 0) throw new Error('EZB-Antwort ohne Kurse')
  return { datum, kurse }
}

/** EUR je 1 Fremdeinheit (Speicherform), auf 8 Stellen wie exchange_rates.rate. */
export function eurJeEinheit(kursJeEur: number): number {
  return Math.round((1 / kursJeEur) * 1e8) / 1e8
}

/** Antwort der Attrappe (EZB_FAKE=1) — Aufbau wie das echte XML. */
export function ezbFakeXml(datum: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='${datum}'>
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='JPY' rate='160.50'/>
      <Cube currency='GBP' rate='0.84000'/>
      <Cube currency='CHF' rate='0.9400'/>
      <Cube currency='CNY' rate='7.8000'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`
}
