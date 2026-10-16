import { createElement as h, type ReactElement } from 'react'
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { sql } from '@/db/client'
import {
  type Anschrift,
  type Firma,
  absenderZeile,
  anschriftZeilen,
  belegFuss,
  belegStile as s,
  datenZeile,
  datum,
  firmaLaden,
  geld,
  menge,
  r2,
  seitenzahl,
} from '@/modules/shared/beleg-pdf'

/**
 * Kundenrechnung, Gutschrift und Mahnung als PDF (0115, Entscheidungslog
 * 2026-10-16). Aufbau nach den bisherigen Belegen des Betreibers: Absender-
 * zeile über der Anschrift, Belegdaten rechts (Nummer, Datum, Referenz,
 * Lieferdatum, Kundennummer, Ansprechpartner), Positionstabelle, Summen,
 * Zahlungshinweis, dreispaltiger Fuß mit den Pflichtangaben (Registergericht,
 * HRB, USt-IdNr., Steuernummer, Geschäftsführung) und Bankverbindung.
 *
 * Shop-Belege zeigen Bruttopreise (Endkunde, Steuer im Preis), manuelle
 * Aufträge Nettopreise mit „zzgl. USt" (Firmenkunde). Bewusst ohne JSX
 * (createElement), damit die Prozesstests dasselbe unter blankem Node rendern.
 */

export interface RechnungKopf {
  id: string
  nummer: string
  art: 'rechnung' | 'gutschrift'
  status: string
  rechnungsdatum: string
  leistungsdatum: string | null
  faellig_am: string | null
  zahlungsart: string | null
  bezahlt_am: string | null
  mahnstufe: number
  waehrung: string
  netto: number
  steuer: number
  brutto: number
  anschrift: Anschrift
  kundennummer: string | null
  kundenreferenz: string | null
  ansprechpartner: string | null
  notiz: string | null
  storno_nummer: string | null
  auftrag_nummer: string | null
  quelle: string | null
  offen: number
  /** Testbeleg des Probelaufs (0117) — Banner im PDF, kein gültiger Beleg. */
  probe?: boolean
}

export interface RechnungPosition {
  bezeichnung: string
  menge: number
  einheit: string
  einzelpreis: number
  listenpreis: number | null
  rabatt_pct: number
  steuersatz: number
  netto: number
  steuer: number
  brutto: number
}

/** Belegtitel nach Art und Mahnstufe. */
export function belegTitel(k: Pick<RechnungKopf, 'art' | 'storno_nummer'>, mahnung?: number): string {
  if (mahnung) return ['Zahlungserinnerung', '1. Mahnung', '2. Mahnung'][mahnung - 1] ?? `${mahnung}. Mahnung`
  if (k.art === 'gutschrift') return k.storno_nummer ? `Gutschrift zu Rechnung ${k.storno_nummer}` : 'Gutschrift'
  return 'Rechnung / Invoice'
}

/** Steuer je Satz zusammengefasst — mehrere Sätze ergeben mehrere Zeilen. */
export function steuerGruppen(positionen: RechnungPosition[]): { satz: number; netto: number; steuer: number }[] {
  const gruppen = new Map<number, { satz: number; netto: number; steuer: number }>()
  for (const p of positionen) {
    const g = gruppen.get(Number(p.steuersatz)) ?? { satz: Number(p.steuersatz), netto: 0, steuer: 0 }
    g.netto = r2(g.netto + Number(p.netto))
    g.steuer = r2(g.steuer + Number(p.steuer))
    gruppen.set(g.satz, g)
  }
  return [...gruppen.values()].sort((a, b) => b.satz - a.satz)
}

/** Zahlungshinweis unter den Summen — abhängig von Art, Status und Zahlungsart. */
export function zahlungsHinweis(k: RechnungKopf, firma: Firma): string {
  if (k.art === 'gutschrift') {
    return k.status === 'bezahlt'
      ? 'Der Betrag wurde erstattet bzw. mit der Rechnung verrechnet.'
      : 'Der Betrag wird Ihnen in den nächsten Tagen erstattet.'
  }
  if (k.status === 'bezahlt') {
    return `Der Betrag wurde am ${datum(k.bezahlt_am)} bereits beglichen${k.zahlungsart ? ` (${k.zahlungsart})` : ''}. Es ist keine Zahlung mehr offen.`
  }
  if (k.status === 'storniert') return 'Diese Rechnung wurde durch eine Gutschrift storniert.'
  const bank = [firma.iban && `IBAN ${firma.iban}`, firma.bic && `BIC ${firma.bic}`, firma.bank].filter(Boolean).join(' · ')
  return `Bitte überweisen Sie den Gesamtbetrag bis zum ${datum(k.faellig_am)} ohne Abzug${bank ? ` auf ${bank}` : ''}. Verwendungszweck: ${k.nummer}.`
}

export function rechnungDokument(
  k: RechnungKopf,
  positionen: RechnungPosition[],
  firma: Firma,
  optionen: { mahnung?: number; mahnfristTage?: number } = {},
): ReactElement {
  const brutto = k.quelle === 'shopify'
  const titel = belegTitel(k, optionen.mahnung)
  const absender = absenderZeile(firma)
  const gruppen = steuerGruppen(positionen)
  const steuerfrei = gruppen.length > 0 && gruppen.every((g) => g.satz === 0)

  const kopf = h(
    View,
    { style: s.kopf },
    h(View, { style: s.anschriftBlock },
      h(Text, { style: s.marke }, (firma.name ?? 'KRNL').toUpperCase()),
      h(Text, { style: { ...s.absender, marginTop: 26 } }, absender),
      h(View, { style: s.anschrift }, ...anschriftZeilen(k.anschrift).map((z, i) => h(Text, { key: String(i) }, z))),
    ),
    h(View, { style: { ...s.daten, marginTop: 44 } },
      datenZeile(k.art === 'gutschrift' ? 'Gutschrift-Nr.' : 'Rechnungs-Nr.', k.nummer, true),
      datenZeile(k.art === 'gutschrift' ? 'Datum' : 'Rechnungsdatum', datum(k.rechnungsdatum)),
      k.kundenreferenz ? datenZeile('Referenz', k.kundenreferenz) : null,
      k.auftrag_nummer ? datenZeile('Auftrag', k.auftrag_nummer) : null,
      datenZeile('Lieferdatum', datum(k.leistungsdatum ?? k.rechnungsdatum)),
      k.art === 'rechnung' && k.status === 'offen' ? datenZeile('Fällig am', datum(k.faellig_am)) : null,
      h(View, { style: { height: 6 } }),
      k.kundennummer ? datenZeile('Ihre Kundennummer', k.kundennummer) : null,
      k.ansprechpartner ? datenZeile('Ihr Ansprechpartner', k.ansprechpartner) : null,
      k.anschrift.vat ? datenZeile('Ihre USt-IdNr.', k.anschrift.vat) : null,
    ),
  )

  const tabelle = h(
    View,
    null,
    h(View, { style: s.kopfzeile },
      h(Text, { style: s.cPos }, 'Pos.'),
      h(Text, { style: s.cText }, 'Beschreibung'),
      h(Text, { style: s.cMenge }, 'Menge'),
      h(Text, { style: s.cPreis }, 'Einzelpreis'),
      h(Text, { style: s.cSumme }, 'Gesamtpreis'),
    ),
    ...positionen.map((p, i) => {
      const faktor = brutto ? 1 + Number(p.steuersatz) / 100 : 1
      const listen = p.listenpreis != null ? r2(Number(p.listenpreis) * faktor) : null
      const einzel = r2(Number(p.einzelpreis) * faktor)
      const gesamt = brutto ? Number(p.brutto) : Number(p.netto)
      const rabatt = listen != null ? r2((listen - einzel) * Number(p.menge)) : 0
      return h(
        View,
        { key: String(i), style: s.zeile, wrap: false },
        h(Text, { style: s.cPos }, `${i + 1}.`),
        h(View, { style: s.cText },
          h(Text, { style: s.fett }, p.bezeichnung),
          !brutto && Number(p.steuersatz) !== gruppen[0]?.satz ? h(Text, { style: s.klein }, `USt ${menge(Number(p.steuersatz))} %`) : null,
        ),
        h(Text, { style: s.cMenge }, `${menge(Number(p.menge))} ${p.einheit}`),
        h(Text, { style: s.cPreis }, geld(listen ?? einzel, k.waehrung)),
        h(View, { style: s.cSumme },
          h(Text, null, geld(gesamt, k.waehrung)),
          rabatt > 0 ? h(Text, { style: s.klein }, `(Rabatt ${geld(rabatt, k.waehrung)})`) : null,
        ),
      )
    }),
  )

  const summeZeile = (label: string, wert: string, grau = false, fett = false) =>
    h(View, { style: grau ? { ...s.summeZeile, ...s.summeGrau } : s.summeZeile },
      h(Text, { style: fett ? { ...s.summeLabel, ...s.fett } : s.summeLabel }, label),
      h(Text, { style: fett ? { ...s.summeWert, ...s.fett } : s.summeWert }, wert))
  const summen = brutto
    ? h(View, { style: s.summen },
        summeZeile('Summe Positionen', geld(k.brutto, k.waehrung), true),
        ...gruppen.map((g) => summeZeile(`Umsatzsteuer ${menge(g.satz)} %`, geld(g.steuer, k.waehrung))),
        summeZeile('Gesamtbetrag netto', geld(k.netto, k.waehrung)),
        summeZeile('Gesamtbetrag brutto', geld(k.brutto, k.waehrung), true, true))
    : h(View, { style: s.summen },
        summeZeile('Gesamtbetrag netto', geld(k.netto, k.waehrung), true),
        ...gruppen.map((g) => summeZeile(`zzgl. Umsatzsteuer ${menge(g.satz)} %`, geld(g.steuer, k.waehrung))),
        summeZeile('Gesamtbetrag brutto', geld(k.brutto, k.waehrung), true, true))

  const mahnung = optionen.mahnung
  const mahnText = mahnung
    ? [
        `zu der nachstehenden Rechnung konnten wir bis heute keinen Zahlungseingang feststellen.`,
        mahnung === 1
          ? 'Sicher ist das in der Fülle des Alltags untergegangen — bitte überweisen Sie den offenen Betrag'
          : mahnung === 2
            ? 'Wir bitten Sie, den offenen Betrag umgehend zu begleichen'
            : 'Trotz Erinnerung und Mahnung ist der Betrag weiter offen. Bitte begleichen Sie ihn',
        `bis zum ${datum(new Date(Date.now() + (optionen.mahnfristTage ?? 7) * 86_400_000).toISOString())}${firma.iban ? ` auf IBAN ${firma.iban}${firma.bic ? `, BIC ${firma.bic}` : ''}` : ''}. Verwendungszweck: ${k.nummer}.`,
        'Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.',
      ].join(' ')
    : null

  const probeBanner = k.probe
    ? h(Text, { style: s.probe },
        'TESTBELEG — Probelauf der Rechnung aus KRNL. Kein gültiger Rechnungsbeleg, keine Zahlungsaufforderung; ' +
        'die gültige Rechnung kommt weiterhin aus sevDesk.')
    : null

  const inhalt = mahnung
    ? [
        probeBanner,
        h(Text, { style: s.titel }, titel),
        h(Text, { style: s.text }, `Sehr geehrte Damen und Herren,`),
        h(Text, { style: s.text }, mahnText),
        h(View, { style: s.kopfzeile },
          h(Text, { style: s.cText }, 'Rechnung'),
          h(Text, { style: s.cPreis }, 'Datum'),
          h(Text, { style: s.cPreis }, 'Fällig am'),
          h(Text, { style: s.cSumme }, 'Offen')),
        h(View, { style: s.zeile },
          h(Text, { style: s.cText }, k.nummer),
          h(Text, { style: s.cPreis }, datum(k.rechnungsdatum)),
          h(Text, { style: s.cPreis }, datum(k.faellig_am)),
          h(Text, { style: { ...s.cSumme, ...s.fett } }, geld(k.offen, k.waehrung))),
        h(Text, { style: s.hinweis }, 'Mit freundlichen Grüßen'),
        h(Text, { style: { fontSize: 9.5 } }, firma.name ?? ''),
      ]
    : [
        probeBanner,
        h(Text, { style: s.titel }, titel),
        tabelle,
        summen,
        steuerfrei ? h(Text, { style: s.hinweis }, 'Keine Umsatzsteuer: steuerfreie Lieferung.') : null,
        h(Text, { style: s.hinweis }, zahlungsHinweis(k, firma)),
        k.notiz ? h(Text, { style: { ...s.hinweis, color: '#333' } }, k.notiz) : null,
      ]

  const fuss = belegFuss(firma)

  const seite = h(
    Page,
    { size: 'A4', style: s.page },
    kopf,
    ...inhalt.filter(Boolean),
    fuss,
    seitenzahl(),
  )
  return h(Document, { title: `${titel} ${k.nummer}`, author: firma.name ?? 'KRNL' }, seite) as ReactElement
}

/** Lädt Beleg, Positionen und Firmendaten und rendert das PDF. */
export async function rechnungPdf(
  id: string,
  art: 'beleg' | 'mahnung' = 'beleg',
): Promise<{ bytes: Buffer; dateiname: string; kopf: RechnungKopf }> {
  const [k] = await sql<RechnungKopf[]>`
    select k.id, k.nummer, k.art::text as art, k.status::text as status,
           k.rechnungsdatum::text as rechnungsdatum, k.leistungsdatum::text as leistungsdatum,
           k.faellig_am::text as faellig_am, k.zahlungsart, k.bezahlt_am::text as bezahlt_am,
           k.mahnstufe, k.waehrung, k.netto, k.steuer, k.brutto, k.anschrift, k.kundennummer,
           k.kundenreferenz, k.ansprechpartner, k.notiz,
           st.nummer as storno_nummer, so.number as auftrag_nummer, so.source::text as quelle,
           kundenrechnung_offen(k.id) as offen, k.probe
    from kundenrechnungen k
    left join kundenrechnungen st on st.id = k.storno_von_id
    left join sales_orders so on so.id = k.sales_order_id
    where k.id = ${id}`
  if (!k) throw new Error('Rechnung nicht gefunden')
  const positionen = await sql<RechnungPosition[]>`
    select bezeichnung, menge, einheit, einzelpreis, listenpreis, rabatt_pct, steuersatz, netto, steuer, brutto
    from kundenrechnung_positionen where rechnung_id = ${id} order by sequence`
  const firma = await firmaLaden()
  const [einst] = await sql<{ mahnfrist: number | null }[]>`
    select (value ->> 'mahnfrist_tage')::int as mahnfrist from settings where key = 'rechnung'`
  const mahnung = art === 'mahnung' ? Math.max(1, Number(k.mahnstufe) || 1) : undefined
  const dokument = rechnungDokument(k, positionen, firma, { mahnung, mahnfristTage: einst?.mahnfrist ?? 7 })
  const bytes = await renderToBuffer(dokument as Parameters<typeof renderToBuffer>[0])
  const dateiname = mahnung ? `${k.nummer}-Mahnung-${mahnung}.pdf` : `${k.nummer}.pdf`
  return { bytes, dateiname, kopf: k }
}
