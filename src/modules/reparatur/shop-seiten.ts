import {
  ANFRAGE_BESCHRIFTUNG as B,
  ANFRAGE_LAENDER,
  ANFRAGE_PFLICHT,
  ANFRAGE_PLATZHALTER,
  type Anfrage,
  type AnfrageFeld,
  FEHLERBESCHREIBUNG_MIN,
  LAENGEN,
} from '../shared/reparaturanfrage.ts'
import { EMAIL_MUSTER } from '../shared/registrierung.ts'

/**
 * Die Seiten des Reparaturformulars im Shop (App Proxy, Entscheidungslog
 * 2026-10-01) — pur, ohne Datenbank und ohne Next, damit Escaping und
 * Inhalt unter blankem Node testbar sind (tests/shop-proxy.test.ts).
 *
 * Shopify rendert Antworten mit `Content-Type: application/liquid` im
 * Theme des Shops. Daraus folgen die Regeln dieser Datei:
 *
 *   - **Im Kleid des Themes:** Markup wie das Kontaktformular eines
 *     Dawn-Themes (`field`/`field__input`/`field__label`, `button`,
 *     `page-width page-width--narrow`, `color-background-1`), dazu dessen
 *     Stylesheet per Liquid (`section-contact-form.css`). Eigenes CSS nur
 *     für Layout-Rückfälle, keine eigenen Farben oder Schriften — sonst sieht
 *     es in einem dunklen Theme falsch aus (Betreiber 2026-10-01).
 *     Keine Assets von unserem Host, keine absoluten URLs dorthin, kein
 *     Produktname des Systems dahinter — der Kunde soll den Shop sehen,
 *     nicht, was dahinter läuft.
 *   - **Liquid-sicher:** Jeder Wert, der vom Kunden oder aus der Datenbank
 *     kommt, läuft durch liquidSicher(): HTML-Escaping UND `{`, `}`, `%` als
 *     Entitäten. Ein getipptes `{{ shop.secret }}` oder `{% … %}` wird so nie
 *     von Shopify ausgewertet; der Browser zeigt es trotzdem richtig an.
 *     Die einzigen Liquid-Ausdrücke sind die hier fest eingebauten
 *     (LIQUID_AUSDRUECKE) — der Test hält genau das fest.
 *   - **Ohne JavaScript bedienbar:** schlichtes `<form method="post">` an den
 *     Proxy-Pfad des Shops; das kleine Inline-Skript prüft nur Pflichtfelder
 *     vorab und verhindert doppeltes Absenden.
 */

/** Die fest eingebauten Liquid-Ausdrücke — alles andere wäre ein Leck. */
export const THEME_CSS = "{{ 'section-contact-form.css' | asset_url | stylesheet_tag }}"
export const LIQUID_AUSDRUECKE = ['{{ shop.name | escape }}', '{{ routes.root_url }}', THEME_CSS] as const

/** Standard-Pfad im Shop, falls path_prefix fehlt oder unbrauchbar ist. */
export const STANDARD_PFAD = '/apps/reparatur'

/**
 * HTML- und Liquid-sicher: zuerst `&` (sonst würden die folgenden Entitäten
 * doppelt kodiert), dann die HTML-Sonderzeichen, dann die drei Zeichen, aus
 * denen Liquid-Tags bestehen.
 */
export function liquidSicher(wert: unknown): string {
  return String(wert ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/%/g, '&#37;')
}

/**
 * Der Pfad, unter dem der Shop das Formular zeigt (`path_prefix` aus der
 * signierten Query, z. B. /apps/reparatur — der Händler kann ihn unter
 * „Customize URL" ändern). Nur ein schlichter Pfad wird übernommen.
 */
export function pfadPraefix(roh: string | null | undefined): string {
  const pfad = (roh ?? '').trim()
  return /^\/[A-Za-z0-9_-][A-Za-z0-9/_-]{0,99}$/.test(pfad) && !pfad.includes('//')
    ? pfad
    : STANDARD_PFAD
}

/**
 * REPARATUR_SHOP_URL (optional): die Adresse des Formulars im Shop, z. B.
 * https://anvil.gg/apps/reparatur. Gesetzt leitet /service/reparatur
 * dorthin um (308). Nur https-Adressen zählen — ein Tippfehler soll die
 * alte Seite stehen lassen, nicht Kunden ins Leere schicken.
 */
export function reparaturShopUrl(env: Record<string, string | undefined> = process.env): string | null {
  const roh = env.REPARATUR_SHOP_URL?.trim() ?? ''
  if (!roh) return null
  try {
    const url = new URL(roh)
    return url.protocol === 'https:' && url.hostname.includes('.') ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Nur Layout-Rückfälle (falls das Theme section-contact-form.css nicht hat)
 * und der unsichtbare Honigtopf — Farben, Schriften, Felder und Knopf kommen
 * vom Theme.
 */
const STIL = [
  '.rp .contact__fields{display:grid;grid-template-columns:1fr;column-gap:2rem}',
  '@media screen and (min-width:750px){.rp .contact__fields{grid-template-columns:repeat(2,1fr)}}',
  '.rp .field{margin-bottom:1.5rem}',
  '.rp-land{margin-bottom:1.5rem}',
  '.rp-land .form__label{display:block;margin-bottom:.6rem}',
  '.rp-fehler{display:block;margin:-1rem 0 1.5rem}',
  '.rp-fehler:empty{display:none}',
  '.rp-honig{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
].join('')

/**
 * Vorabprüfung im Browser (dieselben Meldungen wie der Server) und Schutz
 * vor doppeltem Absenden. Ohne JavaScript greifen required/minlength des
 * Browsers, und der Server prüft ohnehin alles noch einmal.
 */
const SKRIPT = `(function () {
  var f = document.getElementById('rp-formular');
  if (!f) return;
  f.noValidate = true;
  var gesendet = false;
  var mail = new RegExp(${JSON.stringify(EMAIL_MUSTER.source)});
  f.addEventListener('submit', function (e) {
    if (gesendet) { e.preventDefault(); return; }
    var erstes = null;
    f.querySelectorAll('[data-rp-pflicht]').forEach(function (el) {
      var w = el.value.trim();
      var m = '';
      if (!w) m = 'Bitte ausfüllen';
      else if (el.type === 'email' && !mail.test(w)) m = 'Bitte eine gültige E-Mail-Adresse angeben';
      else if (el.minLength > 0 && w.length < el.minLength) m = 'Bitte kurz beschreiben, was nicht funktioniert';
      var s = document.getElementById(el.id + '-fehler');
      if (s) s.textContent = m;
      el.setAttribute('aria-invalid', m ? 'true' : 'false');
      if (m && !erstes) erstes = el;
    });
    if (erstes) { e.preventDefault(); erstes.focus(); return; }
    gesendet = true;
    var k = f.querySelector('button[type=submit]');
    if (k) { k.disabled = true; k.textContent = 'Wird gesendet …'; }
  });
})();`

/** Ersetzt nach dem Erfolg den POST-Eintrag im Verlauf — Neuladen schickt nichts erneut. */
const SKRIPT_VERLAUF = `if (window.history && history.replaceState) history.replaceState(null, '', location.href);`

function seite(inhalt: string, skript = '', themeCss = true): string {
  return (
    (themeCss ? `${THEME_CSS}\n` : '') +
    `<style>${STIL}</style>\n` +
    '<div class="color-background-1 gradient rp">' +
    '<div class="contact page-width page-width--narrow" style="padding-top:36px;padding-bottom:36px">\n' +
    `${inhalt}\n</div></div>\n` +
    (skript ? `<script>\n${skript}\n</script>\n` : '')
  )
}

export interface FormularDaten {
  /** Ziel des Formulars: der Proxy-Pfad im Shop (pfadPraefix). */
  aktion: string
  werte: Partial<Anfrage>
  fehler?: Partial<Record<AnfrageFeld, string>>
  /** Meldung über dem Formular (z. B. gedrosselt). */
  meldung?: string
  /** Bestellnummern des angemeldeten Kunden als Vorschlagsliste. */
  bestellungen?: string[]
  /** Angaben stammen aus dem Kundenkonto. */
  vorausgefuellt?: boolean
}

interface FeldOptionen {
  typ?: 'text' | 'email' | 'tel'
  autocomplete?: string
  liste?: string
  optional?: boolean
}

function beschriftungText(name: AnfrageFeld, optional?: boolean): string {
  const pflicht = ANFRAGE_PFLICHT.includes(name)
  return liquidSicher(B[name]) + (pflicht ? ' <span aria-hidden="true">*</span>' : optional ? ' (optional)' : '')
}

function attribute(name: AnfrageFeld, d: FormularDaten): string {
  const pflicht = ANFRAGE_PFLICHT.includes(name)
  const fehler = d.fehler?.[name]
  return (
    `id="rp-${name}" name="${name}"` +
    (name === 'land' ? '' : ` maxlength="${LAENGEN[name]}"`) +
    (pflicht ? ' required data-rp-pflicht' : '') +
    (fehler ? ' aria-invalid="true"' : '') +
    ` aria-describedby="rp-${name}-fehler"`
  )
}

function fehlerZeile(name: AnfrageFeld, d: FormularDaten): string {
  return `<small class="form__message rp-fehler" id="rp-${name}-fehler">${liquidSicher(d.fehler?.[name] ?? '')}</small>`
}

/** Feld wie im Kontaktformular des Themes: Eingabe, dann schwebendes Label (braucht placeholder). */
function eingabe(name: AnfrageFeld, d: FormularDaten, o: FeldOptionen = {}): string {
  return (
    '<div class="field">' +
    `<input class="field__input" type="${o.typ ?? 'text'}" ${attribute(name, d)} ` +
    `value="${liquidSicher(d.werte[name] ?? '')}" placeholder="${liquidSicher(B[name])}"` +
    (o.autocomplete ? ` autocomplete="${o.autocomplete}"` : '') +
    (o.liste ? ` list="${o.liste}"` : '') +
    '>' +
    `<label class="field__label" for="rp-${name}">${beschriftungText(name, o.optional)}</label>` +
    '</div>' +
    fehlerZeile(name, d)
  )
}

function paar(a: string, b: string): string {
  return `<div class="contact__fields">${a}${b}</div>`
}

const CARET =
  '<svg aria-hidden="true" focusable="false" class="icon icon-caret" viewBox="0 0 10 6">' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M9.354.646a.5.5 0 00-.708 0L5 4.293 1.354.646a.5.5 0 ' +
  '00-.708.708l4 4a.5.5 0 00.708 0l4-4a.5.5 0 000-.708z" fill="currentColor"></path></svg>'

function landAuswahl(d: FormularDaten): string {
  const gewaehlt = (d.werte.land || 'DE').toUpperCase()
  const laender = ANFRAGE_LAENDER.some((l) => l.code === gewaehlt)
    ? ANFRAGE_LAENDER
    : [...ANFRAGE_LAENDER, { code: gewaehlt, name: gewaehlt }]
  const optionen = laender
    .map(
      (l) =>
        `<option value="${liquidSicher(l.code)}"${l.code === gewaehlt ? ' selected' : ''}>` +
        `${liquidSicher(l.name)}</option>`,
    )
    .join('')
  return (
    '<div class="rp-land">' +
    `<label class="form__label" for="rp-land">${beschriftungText('land')}</label>` +
    `<div class="select"><select class="select__select" ${attribute('land', d)} autocomplete="country">` +
    `${optionen}</select>${CARET}</div>` +
    '</div>' +
    fehlerZeile('land', d)
  )
}

function beschreibung(d: FormularDaten): string {
  const hinweis = ANFRAGE_PLATZHALTER.fehlerbeschreibung
  return (
    '<div class="field">' +
    `<textarea class="text-area field__input" ${attribute('fehlerbeschreibung', d)} ` +
    `minlength="${FEHLERBESCHREIBUNG_MIN}" rows="8" placeholder="${liquidSicher(B.fehlerbeschreibung)}">` +
    `${liquidSicher(d.werte.fehlerbeschreibung ?? '')}</textarea>` +
    `<label class="form__label field__label" for="rp-fehlerbeschreibung">${beschriftungText('fehlerbeschreibung')}</label>` +
    '</div>' +
    fehlerZeile('fehlerbeschreibung', d) +
    (hinweis ? `<p class="caption">${liquidSicher(hinweis)}</p>` : '')
  )
}

/** Das Formular — beim ersten Aufruf leer bzw. aus dem Kundenkonto vorbelegt, nach Fehlern mit den Eingaben. */
export function formularSeite(d: FormularDaten): string {
  const bestellungen = (d.bestellungen ?? []).filter(Boolean).slice(0, 5)
  const liste = bestellungen.length
    ? '<datalist id="rp-bestellungen">' +
      bestellungen.map((b) => `<option value="${liquidSicher(b)}"></option>`).join('') +
      '</datalist>'
    : ''
  const hatFehler = Object.values(d.fehler ?? {}).some(Boolean)

  const inhalt = [
    '<h1 class="main-page-title page-title h0">Reparatur anfragen</h1>',
    '<div class="rte"><p>Etwas kaputt? Wir schauen uns das an. Beschreib kurz, was nicht funktioniert, und gib ' +
      'deine Adresse an. Wir prüfen die Anfrage und schicken dir ein <strong>Retourenlabel</strong> ' +
      'per E-Mail. Bitte schick dein Board erst danach los. Nach der Reparatur geht es an dieselbe ' +
      'Adresse zurück.</p>',
    '<p class="caption">Innerhalb der Garantie ist die Reparatur kostenlos. Andernfalls bekommst ' +
      'du vor der Rücksendung ein Angebot.</p></div>',
    d.vorausgefuellt
      ? '<p class="caption">Wir haben deine Angaben aus deinem Kundenkonto übernommen. Bitte ' +
        'kurz prüfen, besonders die Adresse für das Retourenlabel.</p>'
      : '',
    `<form id="rp-formular" class="isolate" method="post" action="${liquidSicher(pfadPraefix(d.aktion))}" ` +
      'accept-charset="UTF-8">',
    d.meldung ? `<p class="form__message" role="alert">${liquidSicher(d.meldung)}</p>` : '',
    hatFehler
      ? '<p class="form__message" role="alert">Bitte prüf die markierten Felder.</p>'
      : '',
    paar(
      eingabe('kontakt_name', d, { autocomplete: 'name' }),
      eingabe('email', d, { typ: 'email', autocomplete: 'email' }),
    ),
    paar(
      eingabe('telefon', d, { typ: 'tel', autocomplete: 'tel' }),
      eingabe('bestellnummer', d, { optional: true, liste: liste ? 'rp-bestellungen' : undefined }),
    ),
    liste,
    paar(
      eingabe('strasse', d, { autocomplete: 'address-line1' }),
      eingabe('hausnummer', d),
    ),
    paar(
      eingabe('plz', d, { autocomplete: 'postal-code' }),
      eingabe('ort', d, { autocomplete: 'address-level2' }),
    ),
    landAuswahl(d),
    beschreibung(d),
    // Honigtopf: für Menschen unsichtbar, Bots füllen ihn aus.
    '<div class="rp-honig" aria-hidden="true"><label for="rp-webseite">Webseite</label>' +
      '<input id="rp-webseite" name="webseite" type="text" tabindex="-1" autocomplete="off" value=""></div>',
    '<div class="contact__button"><button type="submit" class="button">Reparaturanfrage absenden</button></div>',
    '</form>',
    '<p class="caption">{{ shop.name | escape }} verwendet deine Angaben nur ' +
      'zur Bearbeitung der Reparatur.</p>',
  ]
    .filter(Boolean)
    .join('\n')

  return seite(inhalt, SKRIPT)
}

/** Danke-Seite nach dem Absenden. Ohne Nummer (Honigtopf) bleibt sie bewusst allgemein. */
export function dankeSeite(nummer?: string): string {
  const inhalt = [
    `<h1 class="main-page-title page-title h0" role="status">Danke!${nummer ? ` Deine Anfrage hat die Nummer ${liquidSicher(nummer)}.` : ''}</h1>`,
    '<div class="rte">',
    '<p>Du bekommst gleich eine Bestätigung per E-Mail. Wir prüfen die Anfrage und melden uns mit ' +
      'dem Retourenlabel oder einer Rückfrage. Bitte schick dein Board erst los, wenn du das Label ' +
      'hast.</p>',
    nummer
      ? '<p class="caption">Halte die Nummer bei Rückfragen bereit, dann finden wir deine Anfrage ' +
        'sofort.</p>'
      : '',
    '</div>',
    '<p><a class="button" href="{{ routes.root_url }}">Zurück zum Shop</a></p>',
  ]
    .filter(Boolean)
    .join('\n')
  return seite(inhalt, SKRIPT_VERLAUF)
}

/**
 * Neutrale Hinweisseite (unbekannter Pfad, Störung, abgeschaltet) — ohne
 * Liquid-Ausdrücke, damit sie auch dann richtig aussieht, wenn Shopify
 * eine Antwort mit Fehlerstatus nicht durch das Theme schickt.
 */
export function hinweisSeite(h: { titel: string; text: string; aktion?: string; link?: string }): string {
  const inhalt = [
    `<h1 class="main-page-title page-title h0">${liquidSicher(h.titel)}</h1>`,
    `<div class="rte"><p>${liquidSicher(h.text)}</p></div>`,
    h.aktion && h.link
      ? `<p><a href="${liquidSicher(pfadPraefix(h.aktion))}">${liquidSicher(h.link)}</a></p>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  return seite(inhalt, '', false)
}

export function nichtGefundenSeite(aktion: string): string {
  return hinweisSeite({
    titel: 'Diese Seite gibt es nicht',
    text: 'Der Link ist vielleicht veraltet. Das Reparaturformular findest du hier:',
    aktion,
    link: 'Zur Reparaturanfrage',
  })
}

export function stoerungSeite(aktion: string): string {
  return hinweisSeite({
    titel: 'Das hat gerade nicht geklappt',
    // Kein „nichts gespeichert": bricht es erst nach dem Speichern ab, liefert
    // der zweite Versuch dank Dublettenprüfung dieselbe Nummer.
    text: 'Bitte versuch es in ein paar Minuten noch einmal.',
    aktion,
    link: 'Zurück zur Reparaturanfrage',
  })
}

export function nichtVerfuegbarSeite(): string {
  return hinweisSeite({
    titel: 'Reparaturanfragen nehmen wir gerade nicht online entgegen',
    text: 'Schreib uns einfach eine E-Mail, wir helfen trotzdem weiter.',
  })
}
