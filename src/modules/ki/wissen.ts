/**
 * Wissensbasis Prozess-Best-Practices — die EINE, versionierte Quelle für
 * alles, was die KI über gutes Prozessdesign wissen soll. Fließt in den
 * Werkstatt-Kontext des Chat-Agenten (agent.ts) und in die Strukturierung
 * der Prozess-Aufnahme (prozess-aufnahme.ts). Bewusst DB-frei und OHNE
 * 'server-only', damit der Wächter-Test (tests/wissen.test.ts) sie prüfen
 * kann — Muster schema-doku.ts.
 *
 * Pflegeregel: Erkenntnisse aus Kundenterminen und Pilot-Feedback landen
 * HIER (mit Commit + Entscheidungslog bei Grundsatzänderungen) — nicht in
 * verstreuten Prompts. NICHT einfließen lassen in die Realtime-Instructions
 * (sprechen-katalog.ts): dort gilt das 2.000-Zeichen-Budget.
 */

export const PROZESS_WISSEN = `## Best Practices der Prozessmodellierung

GRANULARITÄT: Ein guter Ist-Prozess hat 5–12 Schritte. Ein Schritt ist ein
Arbeitspaket mit klarem Ergebnis („Ware prüfen"), nicht jeder Handgriff
(„Karton öffnen") und nicht eine ganze Abteilung („Logistik"). Wenn zwei
Schritte immer vom selben Menschen direkt nacheinander erledigt werden,
sind sie meist einer.

ZUSTÄNDE: Jeder Aktionsschritt hinterlässt einen benannten Belegzustand —
in der Sprache des Kunden („geprüft", „freigegeben", „beim Versand"), nicht
in ERP-Jargon. Zustände sind Substantive/Partizipien, je Prozess eindeutig.

ENTSCHEIDUNGEN: Jede Weiche ist ein eigener xor-Schritt mit einer
FACHLICHEN Frage als Name („Reklamation berechtigt?"), die ausgehenden
Übergänge tragen die Antworten als Beschriftung („ja"/„nein", „unter
Limit"/„über Limit"). Verzweigungen ohne benannte Bedingung sind ein
Interviewfehler — nachfragen, wonach entschieden wird.

ENDEN: Ein Prozess hat mindestens ein reguläres Ende UND die Abbruchwege
(storniert, abgelehnt, unbegründet) als eigene Enden — der häufigste
Modellierungsfehler ist der vergessene unglückliche Pfad.

ROLLEN: Je Schritt festhalten, WER ihn ausführt. Wechselt die
Zuständigkeit, ist das fast immer eine Schrittgrenze.

DATEN (Felder): Ein Ablauf besteht aus Schritten UND aus dem, was in ihnen
erfasst wird. Frage zu jedem Schritt: „Was tragen Sie hier ein?" und
„Woran sehen Sie später, worum es ging?" Jede Antwort ist ein Feld —
name (technisch, klein_mit_unterstrich), label in Kundensprache, typ
(text/nummer/schalter/auswahl/datum) und die schritte, in deren Maske es
erscheint. Zwei bis drei Felder gehören zusätzlich in die Liste
(in_liste): woran der Kunde eine Zeile wiedererkennt — Kunde, Betrag,
Termin. Felder gehen als felder[] MIT dem Entwurf ein; sie gehören dem
Prozess, nicht dem Beleg-Typ, und sind in Bedingungen sofort als
zusatz.<name> ansprechbar. Ein Prozess ohne ein einziges Feld ist fast
immer ein unvollständiges Interview.

TYPISCHE MUSTER:
- Reklamation: Eingang erfassen → prüfen → xor „berechtigt?" → (ja)
  Lösung wählen [Ersatz/Reparatur/Gutschrift] → ausführen → abschließen;
  (nein) begründen → ablehnen (eigenes Ende).
- Freigabe/Vier-Augen: erfassen → xor „über Limit?" → (ja) Freigabe durch
  Zweitperson (eigene Rolle/Befugnis!) → weiter; (nein) direkt weiter.
- Wareneingang mit Prüfung: avisieren → annehmen → xor „Prüfung nötig?" →
  prüfen → xor „in Ordnung?" → einlagern / zurück an Lieferant.

INTERVIEW-LEITFRAGEN (für Aufnahme und Rückfragen): Was löst den Prozess
aus? Wer macht den ersten Schritt? Was passiert danach, in welcher
Reihenfolge? Wo wird entschieden, und wonach? WAS TRAGEN SIE IN DIESEM
SCHRITT EIN? Wie endet er — auch schief? Was passiert bei Ausnahmen (Kunde
meldet sich nicht, Ware fehlt)? Wie oft läuft er, und wo hakt es heute?

TREUE: Beim IST-Prozess modellieren, was IST — nicht verbessern, nichts
erfinden. Lücken im Gespräch sind Rückfragen, keine Annahmen.
Optimierungen sind ein eigener Schritt danach (neue Version).`

// --- Standard-Bausteine -------------------------------------------------------

export interface StandardFeld {
  name: string
  label: string
  typ: 'text' | 'nummer' | 'schalter' | 'auswahl' | 'datum'
  pflicht?: boolean
  auswahl?: string[]
  in_liste?: boolean
  /** Wo es erfasst wird — Kundensprache; die KI mappt auf ihre Schritt-Codes. */
  erfasst?: string
}

export interface StandardBaustein {
  code: string
  name: string
  /** Woran die KI den Typ im Gespräch erkennt. */
  stichworte: string[]
  /** Schritte in Kundensprache; Entscheidungen als „(Entscheidung) …". */
  schritte: string[]
  felder: StandardFeld[]
  hinweis?: string
}

/**
 * Branchenübliche Prozess-Bausteine: Schritte UND Felder je erkennbarem Typ.
 *
 * Sie drehen die Erhebung um — VORSCHLAGEN statt abfragen: dass eine
 * Eingangsrechnung Rechnungsnummer und Rechnungsdatum braucht, muss der
 * Kunde nicht diktieren; er bestätigt oder streicht. Die Bausteine sind
 * ANKER, keine geschlossene Liste: für unbekannte Typen (Aufmaß,
 * Baustellenbericht, Wartungsvertrag — was auch immer ein Handwerker
 * erzählt) leitet die KI nach demselben Muster ab. Das Korrektiv ist die
 * Abnahme (Maskenvorschau, Streichen), kein Erfindungsverbot.
 */
export const STANDARD_BAUSTEINE: StandardBaustein[] = [
  {
    code: 'angebot_anfrage',
    name: 'Anfrage & Angebot',
    stichworte: ['Anfrage', 'Angebot', 'Interessent', 'Kostenvoranschlag'],
    schritte: [
      'Anfrage erfassen', 'Bedarf klären', 'kalkulieren', 'Angebot senden',
      '(Entscheidung) Antwort des Kunden: Auftrag / nachfassen / verloren',
    ],
    felder: [
      { name: 'ansprechpartner', label: 'Ansprechpartner', typ: 'text', erfasst: 'beim Erfassen' },
      { name: 'kontaktkanal', label: 'Eingang über', typ: 'auswahl', auswahl: ['Telefon', 'E-Mail', 'Messe', 'Website'], erfasst: 'beim Erfassen' },
      { name: 'bedarf', label: 'Was braucht der Kunde?', typ: 'text', erfasst: 'beim Klären' },
      { name: 'angebotssumme_netto', label: 'Angebotssumme (netto)', typ: 'nummer', in_liste: true, erfasst: 'beim Kalkulieren' },
      { name: 'gueltig_bis', label: 'Angebot gültig bis', typ: 'datum', in_liste: true, erfasst: 'beim Senden' },
      { name: 'nachfassen_am', label: 'Nachfassen am', typ: 'datum', erfasst: 'beim Senden' },
    ],
    hinweis: 'Kunde über das Kopffeld partner_id, nicht als eigenes Feld. Gewonnen → vorgang.auftrag_anlegen (Auftrag & Lieferung als Teilprozess verkauf).',
  },
  {
    code: 'eingangsrechnung',
    name: 'Eingangsrechnung',
    stichworte: ['Rechnung', 'Eingangsrechnung', 'bezahlen', 'Skonto', 'Freigabe'],
    schritte: [
      'Rechnung erfassen', 'sachlich prüfen',
      '(Entscheidung) über Freigabelimit? → freigeben', 'zahlen',
      'Abbruchweg: zurückweisen',
    ],
    felder: [
      { name: 'rechnungsnummer', label: 'Rechnungsnummer', typ: 'text', pflicht: true, in_liste: true, erfasst: 'beim Erfassen' },
      { name: 'rechnungsdatum', label: 'Rechnungsdatum', typ: 'datum', pflicht: true, erfasst: 'beim Erfassen' },
      { name: 'betrag_brutto', label: 'Betrag (brutto)', typ: 'nummer', pflicht: true, in_liste: true, erfasst: 'beim Erfassen' },
      { name: 'faellig_am', label: 'Fällig am', typ: 'datum', in_liste: true, erfasst: 'beim Erfassen' },
      { name: 'skonto_bis', label: 'Skonto bis', typ: 'datum', erfasst: 'beim Erfassen' },
    ],
    hinweis: 'Lieferant über das Kopffeld partner_id. Freigabe als eigener Schritt mit Befugnis (Vier-Augen).',
  },
  {
    code: 'reklamation',
    name: 'Reklamation',
    stichworte: ['Reklamation', 'Beschwerde', 'defekt', 'Rückgabe', 'Garantie'],
    schritte: [
      'Eingang erfassen', 'prüfen', '(Entscheidung) berechtigt?',
      'Lösung wählen und ausführen', 'abschließen', 'Abbruchweg: ablehnen',
    ],
    felder: [
      { name: 'grund', label: 'Reklamationsgrund', typ: 'text', pflicht: true, erfasst: 'beim Erfassen' },
      { name: 'kaufdatum', label: 'Kaufdatum', typ: 'datum', erfasst: 'beim Erfassen' },
      { name: 'loesung', label: 'Lösung', typ: 'auswahl', auswahl: ['Ersatz', 'Reparatur', 'Gutschrift'], in_liste: true, erfasst: 'bei der Lösung' },
      { name: 'betrag', label: 'Betrag', typ: 'nummer', erfasst: 'bei der Lösung' },
    ],
  },
  {
    code: 'bewerbung',
    name: 'Bewerbung',
    stichworte: ['Bewerbung', 'Bewerber', 'Stelle', 'Vorstellungsgespräch'],
    schritte: [
      'Eingang erfassen', 'sichten', '(Entscheidung) passt? → Gespräch planen',
      'Gespräch führen', '(Entscheidung) Zusage / Absage',
    ],
    felder: [
      { name: 'stelle', label: 'Stelle', typ: 'text', pflicht: true, in_liste: true, erfasst: 'beim Erfassen' },
      { name: 'quelle', label: 'Quelle', typ: 'auswahl', auswahl: ['Portal', 'Empfehlung', 'Initiativ'], erfasst: 'beim Erfassen' },
      { name: 'gespraech_am', label: 'Gespräch am', typ: 'datum', in_liste: true, erfasst: 'beim Planen' },
      { name: 'gehaltswunsch', label: 'Gehaltswunsch', typ: 'nummer', erfasst: 'beim Sichten' },
    ],
    hinweis: 'Bewerber als Kontakt (partner_id), Bereich personal.',
  },
  {
    code: 'wareneingang_pruefung',
    name: 'Wareneingang mit Prüfung',
    stichworte: ['Wareneingang', 'Anlieferung', 'Lieferschein', 'Qualitätsprüfung'],
    schritte: [
      'avisieren', 'annehmen', '(Entscheidung) Prüfung nötig? → prüfen',
      '(Entscheidung) in Ordnung? → einlagern', 'Abbruchweg: zurück an Lieferant',
    ],
    felder: [
      { name: 'lieferschein_nr', label: 'Lieferschein-Nr.', typ: 'text', pflicht: true, in_liste: true, erfasst: 'beim Annehmen' },
      { name: 'pruefergebnis', label: 'Prüfergebnis', typ: 'auswahl', auswahl: ['in Ordnung', 'Mängel'], in_liste: true, erfasst: 'beim Prüfen' },
      { name: 'maengel', label: 'Mängel', typ: 'text', erfasst: 'beim Prüfen' },
    ],
  },
  {
    code: 'freigabe_vier_augen',
    name: 'Freigabe (Vier-Augen)',
    stichworte: ['Freigabe', 'Genehmigung', 'Limit', 'Vier-Augen'],
    schritte: [
      'erfassen', '(Entscheidung) über Limit? → Freigabe durch Zweitperson',
      'umsetzen',
    ],
    felder: [
      { name: 'betrag', label: 'Betrag', typ: 'nummer', pflicht: true, in_liste: true, erfasst: 'beim Erfassen' },
      { name: 'begruendung', label: 'Begründung', typ: 'text', pflicht: true, erfasst: 'beim Erfassen' },
      { name: 'frist', label: 'Frist', typ: 'datum', erfasst: 'beim Erfassen' },
    ],
    hinweis: 'Die Freigabe trägt eine Befugnis am Schritt — nicht ein Feld „freigegeben von".',
  },
]

/** Kompakte Promptform der Bausteine — eine Quelle für Interview, Aufnahme und Werkstatt. */
export function bausteineAlsText(): string {
  return STANDARD_BAUSTEINE.map((b) => {
    const felder = b.felder
      .map((f) => {
        const attr = [
          f.typ,
          f.pflicht ? 'Pflicht' : null,
          f.auswahl ? f.auswahl.join('/') : null,
          f.in_liste ? 'Liste' : null,
          f.erfasst ?? null,
        ].filter(Boolean)
        return `${f.name} „${f.label}" (${attr.join(', ')})`
      })
      .join(' · ')
    return (
      `### ${b.name} — erkennbar an: ${b.stichworte.join(', ')}\n` +
      `Schritte: ${b.schritte.join(' → ')}\n` +
      `Felder: ${felder}` +
      (b.hinweis ? `\nHinweis: ${b.hinweis}` : '')
    )
  }).join('\n\n')
}

/**
 * Der Werkstatt-Zusatz für den Chat-Agenten: Rolle, Wissen, Arbeitsweise.
 * Wird NUR im Werkstatt-Kontext an den Systemprompt gehängt — normale
 * Chat-Runden zahlen die Tokens nicht.
 */
export function werkstattSystemZusatz(): string {
  return `

## Kontext: Prozess-Werkstatt

Du bist hier der PROZESS-ARCHITEKT: Der Admin baut mit dir Prozesse — im
Dialog, mit Zwischenständen, Tabellen und Entwürfen. Arbeite iterativ:
erst verstehen (nachfragen!), dann einen Entwurf vorschlagen, dann auf
Zuruf verfeinern.

Arbeitsweise:
- BESTAND ZUERST: Vor jedem Umbau die aktuellen Schritte und Übergänge per
  sql_abfrage aus prozess_schritte/prozess_uebergaenge der aktiven Version
  nachschlagen und als Tabelle zeigen — nie aus dem Gedächtnis umbauen.
- ENTWÜRFE NUR über aktion_vorschlagen mit einstellungen.prozess_entwerfen —
  es entsteht immer nur ein ENTWURF (neue Version, nichts wird aktiv).
  Nach der Bestätigung entsteht das Diagramm zur Sichtprüfung unter
  /prozesse/<code>; AKTIVIERT wird dort von Hand, nie durch dich.
- Für Kunden-Ist-Prozesse: modell 'vorgang' mit frei definierten Zuständen
  (vorgang.anlegen als erster Schritt — MIT zustand, das ist der
  Einstiegszustand —, danach vorgang.status_setzen je Zustand).
- FELDER GEHÖREN IN DEN ENTWURF: felder[] ist kein Extra, sondern die halbe
  Maske. Ohne sie bekommt der Kunde eine Oberfläche, in der er nichts
  eintragen kann außer einem Titel. Zeige die geplanten Felder in der
  Zusammenfassung mit — Schrittliste UND Feldliste.
- VORSCHLAGEN STATT ABFRAGEN: Erkennst du einen der Standard-Bausteine
  unten, übernimm dessen Schritte und Felder als Vorlage und lass den
  Kunden bestätigen oder streichen. Erkennst du keinen, leite nach
  demselben Muster branchenübliche Schritte und Felder ab — so wenig
  Eingabe wie möglich für den Kunden. Was er ausdrücklich sagt, hat
  immer Vorrang.
- Fasse vor jedem Entwurf den geplanten Ablauf als kurze Schrittliste
  zusammen und hole ein Okay — der Entwurf soll bestätigen, nicht raten.

${PROZESS_WISSEN}

## Standard-Bausteine (Vorlagen — anpassen, nicht abfragen)

${bausteineAlsText()}`
}
