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
 *   - **Selbsttragend:** Stil und Skript inline, Klassen mit Präfix `rp-`,
 *     Farben und Schriften aus den CSS-Variablen des Themes (mit Rückfall).
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
export const LIQUID_AUSDRUECKE = ['{{ shop.name | escape }}', '{{ routes.root_url }}'] as const

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

const STIL = [
  '.rp{--rp-text:rgb(var(--color-foreground,18,18,18));--rp-leise:rgba(var(--color-foreground,18,18,18),.72);',
  '--rp-rand:rgba(var(--color-foreground,18,18,18),.3);--rp-flaeche:rgba(var(--color-foreground,18,18,18),.05);',
  '--rp-grund:rgb(var(--color-background,255,255,255));--rp-knopf:rgb(var(--color-button,18,18,18));',
  '--rp-knopf-text:rgb(var(--color-button-text,255,255,255));--rp-fehler:#b3261e;',
  'color:var(--rp-text);font-family:var(--font-body-family,inherit);padding-top:2.5rem;padding-bottom:4rem}',
  '.rp-inhalt{max-width:46rem}',
  '.rp-titel{font-family:var(--font-heading-family,inherit);font-weight:var(--font-heading-weight,600);',
  'font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.2;margin:0 0 1rem}',
  '.rp p{line-height:1.6;margin:0 0 .9rem}',
  '.rp a{color:inherit;text-decoration:underline;text-underline-offset:.2em}',
  '.rp-leise{color:var(--rp-leise);font-size:.92em}',
  '.rp-fuss{margin-top:1.2rem}',
  '.rp-hinweis{background:var(--rp-flaeche);padding:.8rem 1rem;margin:1.2rem 0}',
  '.rp-form{margin-top:2rem}',
  '.rp-paar{display:grid;grid-template-columns:1fr 1fr;gap:0 1.2rem}',
  '@media (max-width:640px){.rp-paar{grid-template-columns:1fr}}',
  '.rp-feld{display:flex;flex-direction:column;margin-bottom:1.1rem}',
  '.rp-feld label{font-size:.95em;margin-bottom:.35rem}',
  '.rp-feld input,.rp-feld select,.rp-feld textarea{font:inherit;font-size:1rem;color:var(--rp-text);',
  'background:var(--rp-grund);border:1px solid var(--rp-rand);border-radius:var(--inputs-radius,0);',
  'padding:.7rem .8rem;width:100%;max-width:100%;box-sizing:border-box;margin:0}',
  '.rp-feld textarea{min-height:9rem;resize:vertical}',
  '.rp-feld input:focus,.rp-feld select:focus,.rp-feld textarea:focus{outline:2px solid var(--rp-text);outline-offset:1px}',
  '.rp-feld [aria-invalid=true]{border-color:var(--rp-fehler)}',
  '.rp-fehler{color:var(--rp-fehler);font-size:.88em;margin-top:.3rem}',
  '.rp-fehler:empty{display:none}',
  '.rp-meldung{border:1px solid var(--rp-fehler);color:var(--rp-fehler);padding:.8rem 1rem;margin:0 0 1.2rem}',
  '.rp-honig{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
  '.rp-knopf{font:inherit;font-size:1rem;cursor:pointer;border:0;border-radius:var(--buttons-radius,0);',
  'background:var(--rp-knopf);color:var(--rp-knopf-text);padding:.9rem 1.8rem;min-height:3rem}',
  '.rp-knopf[disabled]{opacity:.6;cursor:default}',
  '.rp-karte{border:1px solid var(--rp-rand);padding:1.5rem 1.6rem}',
  '.rp-marke{text-transform:uppercase;letter-spacing:.08em;font-size:.8em;color:var(--rp-leise)}',
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

function seite(inhalt: string, skript = ''): string {
  return (
    `<style>${STIL}</style>\n` +
    `<div class="page-width rp"><div class="rp-inhalt">\n${inhalt}\n</div></div>\n` +
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

function beschriftung(name: AnfrageFeld, optional?: boolean): string {
  const pflicht = ANFRAGE_PFLICHT.includes(name)
  return (
    `<label for="rp-${name}">${liquidSicher(B[name])}` +
    (pflicht ? ' <span aria-hidden="true">*</span>' : optional ? ' (optional)' : '') +
    '</label>'
  )
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
  return `<span class="rp-fehler" id="rp-${name}-fehler">${liquidSicher(d.fehler?.[name] ?? '')}</span>`
}

function eingabe(name: AnfrageFeld, d: FormularDaten, o: FeldOptionen = {}): string {
  const platzhalter = ANFRAGE_PLATZHALTER[name]
  return (
    '<div class="rp-feld">' +
    beschriftung(name, o.optional) +
    `<input type="${o.typ ?? 'text'}" ${attribute(name, d)} value="${liquidSicher(d.werte[name] ?? '')}"` +
    (o.autocomplete ? ` autocomplete="${o.autocomplete}"` : '') +
    (o.liste ? ` list="${o.liste}"` : '') +
    (platzhalter ? ` placeholder="${liquidSicher(platzhalter)}"` : '') +
    '>' +
    fehlerZeile(name, d) +
    '</div>'
  )
}

function paar(a: string, b: string): string {
  return `<div class="rp-paar">${a}${b}</div>`
}

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
    '<div class="rp-feld">' +
    beschriftung('land') +
    `<select ${attribute('land', d)} autocomplete="country">${optionen}</select>` +
    fehlerZeile('land', d) +
    '</div>'
  )
}

function beschreibung(d: FormularDaten): string {
  const platzhalter = ANFRAGE_PLATZHALTER.fehlerbeschreibung
  return (
    '<div class="rp-feld">' +
    beschriftung('fehlerbeschreibung') +
    `<textarea ${attribute('fehlerbeschreibung', d)} minlength="${FEHLERBESCHREIBUNG_MIN}" rows="6"` +
    (platzhalter ? ` placeholder="${liquidSicher(platzhalter)}"` : '') +
    `>${liquidSicher(d.werte.fehlerbeschreibung ?? '')}</textarea>` +
    fehlerZeile('fehlerbeschreibung', d) +
    '</div>'
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
    '<h1 class="rp-titel">Reparatur anfragen</h1>',
    '<p>Etwas kaputt? Wir schauen uns das an. Beschreiben Sie kurz, was nicht funktioniert, und ' +
      'geben Sie Ihre Adresse an. Wir prüfen die Anfrage und schicken Ihnen ein ' +
      '<strong>Retourenlabel</strong> per E-Mail — bitte senden Sie das Gerät erst danach. Nach der ' +
      'Reparatur geht es an dieselbe Adresse zurück.</p>',
    '<p class="rp-leise">Innerhalb der Garantie ist die Reparatur kostenlos. Andernfalls erhalten ' +
      'Sie vor der Rücksendung ein Angebot.</p>',
    d.vorausgefuellt
      ? '<p class="rp-hinweis">Wir haben Ihre Angaben aus Ihrem Kundenkonto übernommen — bitte kurz ' +
        'prüfen, besonders die Adresse für das Retourenlabel.</p>'
      : '',
    `<form id="rp-formular" class="rp-form" method="post" action="${liquidSicher(pfadPraefix(d.aktion))}" ` +
      'accept-charset="UTF-8">',
    d.meldung ? `<p class="rp-meldung" role="alert">${liquidSicher(d.meldung)}</p>` : '',
    hatFehler
      ? '<p class="rp-meldung" role="alert">Bitte prüfen Sie die markierten Felder.</p>'
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
    '<button type="submit" class="rp-knopf">Reparaturanfrage absenden</button>',
    '</form>',
    '<p class="rp-leise rp-fuss">{{ shop.name | escape }} verwendet Ihre Angaben nur ' +
      'zur Bearbeitung der Reparatur.</p>',
  ]
    .filter(Boolean)
    .join('\n')

  return seite(inhalt, SKRIPT)
}

/** Danke-Seite nach dem Absenden. Ohne Nummer (Honigtopf) bleibt sie bewusst allgemein. */
export function dankeSeite(nummer?: string): string {
  const inhalt = [
    '<div class="rp-karte" role="status">',
    '<p class="rp-marke">Anfrage eingegangen</p>',
    `<h1 class="rp-titel">Danke${nummer ? ` — Ihre Anfrage hat die Nummer ${liquidSicher(nummer)}` : ''}.</h1>`,
    '<p>Sie erhalten gleich eine Bestätigung per E-Mail. Wir prüfen die Anfrage und melden uns mit ' +
      'dem Retourenlabel oder einer Rückfrage. Bitte schicken Sie das Gerät erst nach Erhalt des ' +
      'Labels.</p>',
    nummer
      ? '<p class="rp-leise">Halten Sie die Nummer bei Rückfragen bereit — sie hilft uns, Ihre ' +
        'Anfrage sofort zu finden.</p>'
      : '',
    '<p><a href="{{ routes.root_url }}">Zurück zum Shop</a></p>',
    '</div>',
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
    '<div class="rp-karte">',
    `<h1 class="rp-titel">${liquidSicher(h.titel)}</h1>`,
    `<p>${liquidSicher(h.text)}</p>`,
    h.aktion && h.link
      ? `<p><a href="${liquidSicher(pfadPraefix(h.aktion))}">${liquidSicher(h.link)}</a></p>`
      : '',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
  return seite(inhalt)
}

export function nichtGefundenSeite(aktion: string): string {
  return hinweisSeite({
    titel: 'Diese Seite gibt es nicht',
    text: 'Der Link ist vielleicht veraltet. Das Reparaturformular finden Sie hier:',
    aktion,
    link: 'Zur Reparaturanfrage',
  })
}

export function stoerungSeite(aktion: string): string {
  return hinweisSeite({
    titel: 'Das hat gerade nicht geklappt',
    // Kein „nichts gespeichert": bricht es erst nach dem Speichern ab, liefert
    // der zweite Versuch dank Dublettenprüfung dieselbe Nummer.
    text: 'Bitte versuchen Sie es in ein paar Minuten noch einmal.',
    aktion,
    link: 'Zurück zur Reparaturanfrage',
  })
}

export function nichtVerfuegbarSeite(): string {
  return hinweisSeite({
    titel: 'Reparaturanfragen nehmen wir gerade nicht online entgegen',
    text: 'Bitte melden Sie sich per E-Mail bei uns — wir helfen trotzdem weiter.',
  })
}
