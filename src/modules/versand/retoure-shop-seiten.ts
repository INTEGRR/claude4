import { CARET, liquidSicher, pfadPraefix, shopSeite, SKRIPT_VERLAUF } from '../reparatur/shop-seiten.ts'
import { RETOURE_GRUENDE } from './retoure-gruende.ts'

/**
 * Seiten des Retourenportals im Shop (0119) — dieselbe App „reparatur",
 * derselbe Rahmen wie die Reparaturanfrage, Unterpfad /retoure. Zwei Schritte:
 * Bestellung finden (Nummer + E-Mail; angemeldete Kunden wählen aus ihren
 * Bestellungen), dann Artikel, Menge und Grund wählen.
 */

export interface SuchDaten {
  aktion: string
  bestellnummer?: string
  email?: string
  bestellungen?: string[]
  meldung?: string
}

export interface AuswahlDaten {
  aktion: string
  bestellnummer: string
  email: string
  zeilen: { id: string; name: string; frei: number }[]
  meldung?: string
  werte?: Record<string, string>
}

const ziel = (aktion: string) => `${pfadPraefix(aktion)}/retoure`

function feld(name: string, label: string, wert: string, typ = 'text', extra = ''): string {
  return (
    '<div class="field">' +
    `<input class="field__input" type="${typ}" id="rt-${name}" name="${name}" value="${liquidSicher(wert)}" ` +
    `placeholder="${liquidSicher(label)}" ${extra}>` +
    `<label class="field__label" for="rt-${name}">${liquidSicher(label)}</label>` +
    '</div>'
  )
}

const HONIG =
  '<div class="rp-honig" aria-hidden="true"><label for="rt-webseite">Webseite</label>' +
  '<input id="rt-webseite" name="webseite" type="text" tabindex="-1" autocomplete="off" value=""></div>'

export function suchSeite(d: SuchDaten): string {
  const bestellungen = (d.bestellungen ?? []).filter(Boolean).slice(0, 10)
  const auswahl = bestellungen.length
    ? '<div class="rp-land"><label class="form__label" for="rt-bestellnummer">Deine Bestellung</label>' +
      '<div class="select"><select class="select__select" id="rt-bestellnummer" name="bestellnummer">' +
      bestellungen
        .map((b) => `<option value="${liquidSicher(b)}"${b === d.bestellnummer ? ' selected' : ''}>${liquidSicher(b)}</option>`)
        .join('') +
      `</select>${CARET}</div></div>`
    : `<div class="contact__fields">${feld('bestellnummer', 'Bestellnummer (z. B. #1042)', d.bestellnummer ?? '', 'text', 'required maxlength="40"')}` +
      `${feld('email', 'E-Mail der Bestellung', d.email ?? '', 'email', 'required maxlength="200" autocomplete="email"')}</div>`
  const inhalt = [
    '<h1 class="main-page-title page-title h0">Rücksendung anmelden</h1>',
    '<div class="rte"><p>Passt etwas nicht? Wähl deine Bestellung und die Artikel aus, die du zurückschicken ' +
      'möchtest. Wir prüfen die Anfrage und schicken dir ein <strong>Retourenlabel</strong> per E-Mail. ' +
      'Sobald das Paket bei uns ist und geprüft wurde, erstatten wir den Betrag.</p></div>',
    `<form class="isolate" method="post" action="${liquidSicher(ziel(d.aktion))}" accept-charset="UTF-8">`,
    '<input type="hidden" name="schritt" value="suchen">',
    d.meldung ? `<p class="form__message" role="alert">${liquidSicher(d.meldung)}</p>` : '',
    auswahl,
    HONIG,
    '<div class="contact__button"><button type="submit" class="button">Weiter</button></div>',
    '</form>',
    '<p class="caption">Für eine Reparatur statt Rücksendung nutz bitte die ' +
      `<a href="${liquidSicher(pfadPraefix(d.aktion))}">Reparaturanfrage</a>.</p>`,
  ]
    .filter(Boolean)
    .join('\n')
  return shopSeite(inhalt)
}

export function auswahlSeite(d: AuswahlDaten): string {
  const w = d.werte ?? {}
  const zeilen = d.zeilen
    .map((z) => {
      const mengen = Array.from({ length: Math.floor(z.frei) + 1 }, (_, i) => i)
        .map((i) => `<option value="${i}"${String(i) === (w[`menge_${z.id}`] ?? (d.zeilen.length === 1 ? String(Math.floor(z.frei)) : '0')) ? ' selected' : ''}>${i}</option>`)
        .join('')
      const gruende = ['<option value="">Grund wählen</option>']
        .concat(RETOURE_GRUENDE.map((g) => `<option value="${liquidSicher(g)}"${w[`grund_${z.id}`] === g ? ' selected' : ''}>${liquidSicher(g)}</option>`))
        .join('')
      return (
        '<div class="rp-land" style="border-bottom:1px solid rgba(0,0,0,.08);padding-bottom:1rem">' +
        `<p class="h5" style="margin:0 0 .6rem">${liquidSicher(z.name)}</p>` +
        '<div class="contact__fields">' +
        `<div><label class="form__label" for="rt-menge-${z.id}">Menge</label><div class="select">` +
        `<select class="select__select" id="rt-menge-${z.id}" name="menge_${z.id}">${mengen}</select>${CARET}</div></div>` +
        `<div><label class="form__label" for="rt-grund-${z.id}">Grund</label><div class="select">` +
        `<select class="select__select" id="rt-grund-${z.id}" name="grund_${z.id}">${gruende}</select>${CARET}</div></div>` +
        '</div></div>'
      )
    })
    .join('\n')
  const inhalt = [
    `<h1 class="main-page-title page-title h0">Rücksendung · ${liquidSicher(d.bestellnummer)}</h1>`,
    '<div class="rte"><p>Wähl die Artikel und die Menge, die du zurückschicken möchtest.</p></div>',
    `<form class="isolate" method="post" action="${liquidSicher(ziel(d.aktion))}" accept-charset="UTF-8">`,
    '<input type="hidden" name="schritt" value="absenden">',
    `<input type="hidden" name="bestellnummer" value="${liquidSicher(d.bestellnummer)}">`,
    `<input type="hidden" name="email" value="${liquidSicher(d.email)}">`,
    d.meldung ? `<p class="form__message" role="alert">${liquidSicher(d.meldung)}</p>` : '',
    zeilen,
    '<div class="field">' +
      '<textarea class="text-area field__input" id="rt-anliegen" name="anliegen" rows="4" maxlength="1000" ' +
      'placeholder="Möchtest du uns noch etwas sagen? (optional)">' +
      `${liquidSicher(w.anliegen ?? '')}</textarea>` +
      '<label class="form__label field__label" for="rt-anliegen">Möchtest du uns noch etwas sagen? (optional)</label></div>',
    HONIG,
    '<div class="contact__button"><button type="submit" class="button">Rücksendung anmelden</button></div>',
    '</form>',
  ]
    .filter(Boolean)
    .join('\n')
  return shopSeite(inhalt)
}

export function retoureDankeSeite(nummer?: string): string {
  const inhalt = [
    `<h1 class="main-page-title page-title h0" role="status">Danke!${nummer ? ` Deine Rücksendung hat die Nummer ${liquidSicher(nummer)}.` : ''}</h1>`,
    '<div class="rte"><p>Du bekommst gleich eine Bestätigung per E-Mail. Wir prüfen die Anfrage und schicken ' +
      'dir das Retourenlabel. Bitte schick die Ware erst los, wenn du das Label hast, und leg einen Zettel ' +
      'mit der Nummer bei.</p></div>',
    '<p><a class="button" href="{{ routes.root_url }}">Zurück zum Shop</a></p>',
  ].join('\n')
  return shopSeite(inhalt, SKRIPT_VERLAUF)
}
