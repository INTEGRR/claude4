import type { Metadata } from 'next'
import Link from 'next/link'
import { HexcoreMark, Wortmarke } from '@/components/marke'
import { Eyebrow, Seg } from './anzeige'
import { KostenRechner } from './kosten-rechner'
import { ProzessVorschau } from './prozess-vorschau'
import { Registrierung } from './registrierung'
import { SprechVorschau } from './sprech-vorschau'
import './start.css'

/**
 * Die öffentliche Startseite — was KRNL ist, für wen, und wie ein Einstieg
 * abläuft. Liegt bewusst AUSSERHALB der (erp)-Gruppe und bringt ihr eigenes
 * Stylesheet mit: sie soll später als separates Vercel-Deployment
 * herausgezogen werden können, ohne das ERP mitzuschleppen. Bis dahin ist
 * sie die Seite vor dem Login (Weiche in der Middleware).
 *
 * Inhalte folgen der Positionierung, nicht dem Funktionsumfang: Prozess
 * First (der Ablauf ist die Software, nicht die Maske), Sprechen als
 * Einstieg, eigene Instanz je Kunde, und der Kostenblock, der die eigentliche
 * These trägt — das Customizing-Projekt entfällt. Keine erfundenen
 * Referenzen oder Kundenzahlen: was hier steht, kann das System. Einzige
 * Ausnahme mit Ansage sind die Annahmen des Kostenrechners (Platzhalter,
 * siehe docs/website.md und die Disclaimer-Zeile im Rechner selbst).
 *
 * Aufbau nach dem Design-Handoff „KRNL Sales": heller Chassis-Grund, dunkle
 * eingelassene Anzeigen für alles Technische, drei interaktive Stücke
 * (Prozessversion umschalten, Bestätigungstor, Kostenrechner) und das
 * Anmeldeformular.
 */

export const metadata: Metadata = {
  title: 'KRNL — das ERP, das eurem Prozess folgt',
  description:
    'KRNL ist ein Prozess-ERP: Ihr diktiert euren Ablauf, KRNL setzt ihn um — '
    + 'ohne Entwicklung. Sprachgesteuert, deutsch, mit eigener Instanz je Kunde.',
}

const NAVIGATION = [
  { href: '#prozess', label: 'Prozess First' },
  { href: '#sprechen', label: 'Sprechen' },
  { href: '#einstieg', label: 'Einstieg' },
  { href: '#betrieb', label: 'Betrieb' },
  { href: '#kosten', label: 'Kosten' },
]

const SONST = [
  'Der Ablauf steckt in Masken und im Kopf der Entwicklung.',
  'Jede Abweichung ist ein Anpassungsprojekt mit Angebot und Wartezeit.',
  'Alle Kunden bekommen dieselbe Maske und lassen die Hälfte leer.',
  'Niemand kann zeigen, wie der Ablauf im System tatsächlich aussieht.',
]

const IN_KRNL = [
  'Der Ablauf ist eine Prozessversion — sichtbar als Diagramm, jederzeit.',
  'Schritte umbauen heißt: neue Version entwerfen, prüfen, schalten.',
  'Jede Firma bekommt ihre eigenen Schritte, Zustände und Bezeichnungen.',
  'Was der Ablauf nicht vorsieht, taucht in der Oberfläche gar nicht erst auf.',
]

const KANN = [
  {
    titel: 'Zählen ohne Zettel',
    punkt: true,
    text: 'Inventur im Dialog: Artikel nennen, Menge sagen, weiter. Die Zählungen '
      + 'sammeln sich in einer Prüftabelle und werden erst nach Sichtprüfung gebucht — '
      + 'gesammelt, nicht im Vorbeigehen.',
  },
  {
    titel: 'Fragen statt Suchen',
    punkt: false,
    text: '„Wie viele Schalter sind noch da, und wann kommt Nachschub?" — die Antwort '
      + 'kommt aus den echten Beständen und offenen Zuläufen, nicht aus einem Bericht, '
      + 'den erst jemand bauen muss.',
  },
  {
    titel: 'Handeln mit Freigabe',
    punkt: false,
    text: 'Auch Buchungen gehen per Zuruf — aber jede schreibende Aktion läuft durch '
      + 'dieselbe Prüfung wie ein Klick: Rolle, Befugnis, Prozessschritt. Die Stimme '
      + 'bekommt keine Sonderrechte.',
  },
]

const BAUSTEINE = [
  {
    nr: 1,
    titel: 'Aufnehmen',
    text: 'Wir setzen uns mit euch hin, ihr erzählt euren Ablauf, wie er heute wirklich ist. '
      + 'Der Assistent hört zu, fragt nach Auslöser, Zuständigkeiten, Ausnahmen — und fasst zusammen.',
  },
  {
    nr: 2,
    titel: 'Zeichnen',
    text: 'Aus dem Gespräch entsteht ein Prozessdiagramm: Schritte, Entscheidungen, Abbruchwege. '
      + 'Ihr schaut drauf und sagt, was nicht stimmt. Das ist die Abnahme — kein Lastenheft.',
  },
  {
    nr: 3,
    titel: 'Läuft',
    text: 'Der freigegebene Ablauf wird geschaltet und ist ab dem Moment das System: '
      + 'Masken, Knöpfe und Navigation entstehen aus den Schritten. Keine Entwicklungsrunde dazwischen.',
  },
]

const BETRIEB = [
  {
    nr: '01',
    titel: 'Getrennt',
    kern: false,
    text: 'Eigene Datenbank je Kunde. Ein fehlerhaftes Update trifft höchstens eine '
      + 'Instanz, und eine Wiederherstellung betrifft nur eure Daten.',
  },
  {
    nr: '02',
    titel: 'Rückholbar',
    kern: true,
    text: 'Point-in-Time-Recovery je Instanz, mit geprobter Wiederherstellung — ein '
      + 'Backup, das nie zurückgespielt wurde, zählt nicht.',
  },
  {
    nr: '03',
    titel: 'Geprüft',
    kern: true,
    text: 'Ein nächtlicher Daten-TÜV rechnet Bestände, Reservierungen und Wertschichten '
      + 'gegen das Bewegungsjournal. Abweichungen schlagen Alarm, statt still weiterzulaufen.',
  },
]

export default function StartSeite() {
  return (
    <div className="krnl-start">
      <header className="kopf">
        <div className="bahn">
          <Link href="/start" className="marke">
            <HexcoreMark groesse={26} variante="einfach" />
            <Wortmarke groesse={20} />
          </Link>
          <nav>
            {NAVIGATION.map((n) => (
              <a key={n.href} className="weg" href={n.href}>{n.label}</a>
            ))}
            <Link className="taste fuehrend" href="/login">Anmelden</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="held">
          <div className="bahn">
            <div className="statusstreifen">
              <span className="mono"><span className="punkt" /> Prozess-ERP · deutsch · sprachgesteuert</span>
              <span className="mono"><span className="punkt kern" /> Betrieb in der EU · eigene Instanz je Kunde</span>
            </div>
            <div className="held-raster">
              <div>
                <Eyebrow text="Prozess First" />
                <h1>
                  Das ERP richtet sich nach eurem Prozess.{' '}
                  <em>Nicht umgekehrt.</em>
                </h1>
                <p>
                  In KRNL sind Abläufe keine Programmierung, sondern Daten. Ihr erzählt,
                  wie bei euch gearbeitet wird — daraus entsteht ein Diagramm, und aus
                  dem Diagramm wird die laufende Software.
                </p>
                <p className="betont">
                  Ändert sich der Ablauf, ändert sich das System: am selben Tag, ohne Release.
                </p>
                <div className="knopfreihe">
                  <Link className="taste fuehrend" href="#anmelden">Erstgespräch anfragen →</Link>
                  <a className="zweitweg" href="#einstieg">Wie ein Einstieg abläuft</a>
                </div>
              </div>
              {/* Das Kernversprechen zum Anfassen — nicht Dekoration. */}
              <ProzessVorschau />
            </div>
          </div>
        </section>

        <section id="prozess">
          <div className="bahn">
            <Eyebrow text="Prozess First" />
            <h2>Standard-Software zwingt euch in fremde Abläufe.</h2>
            <p className="lead">
              Der übliche Weg: Man kauft ein ERP, danach beginnt das Anpassen —
              erst die Software, dann die Firma. KRNL dreht das um. Ein Prozess ist
              hier eine Version in der Datenbank, kein Sonderweg im Code.
            </p>
            <div className="gegen">
              <div className="sonst">
                <h3>Sonst</h3>
                <ul>
                  {SONST.map((t) => (
                    <li key={t}><span className="marker">—</span><span>{t}</span></li>
                  ))}
                </ul>
              </div>
              <div className="so">
                <h3>In KRNL</h3>
                <ul>
                  {IN_KRNL.map((t) => (
                    <li key={t}><span className="marker">▚</span><span>{t}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="sprechen">
          <div className="bahn">
            <Eyebrow text="Sprechen" />
            <h2>Der Einstieg ins System ist ein Gespräch.</h2>
            <p className="lead">
              Am Packtisch, im Lager, unterwegs: Tippen ist der Umweg. In KRNL ist
              Sprechen der Hauptzugang — mit Bestätigung vor jeder Buchung, weil
              ein ERP nichts stillschweigend verändern darf.
            </p>
            <div className="zwei sprechen">
              <SprechVorschau />
              <div className="kette senkrecht">
                {KANN.map((k) => (
                  <div key={k.titel}>
                    <h3>{k.punkt && <span className="punkt" />}{k.titel}</h3>
                    <p>{k.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="einstieg">
          <div className="bahn">
            <Eyebrow text="Einstieg" />
            <h2>Von eurem Ablauf zum laufenden System — in drei Schritten.</h2>
            <p className="lead">
              Kein monatelanges Einführungsprojekt: Der erste Termin ist kein Workshop
              über Software, sondern ein Gespräch über eure Arbeit.
            </p>
            <div className="kette drei">
              {BAUSTEINE.map((b) => (
                <div key={b.nr}>
                  <div className="schrittkopf">
                    <span className="mono">Schritt 0{b.nr}</span>
                    <Seg wert={`0${b.nr}`} farbe={b.nr === 2 ? 'kernel' : 'signal'} />
                  </div>
                  <h3>{b.titel}</h3>
                  <p>{b.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="betrieb">
          <div className="bahn">
            <Eyebrow text="Betrieb" />
            <h2>Eure Daten liegen in eurer Instanz.</h2>
            <p className="lead">
              Jeder Kunde bekommt ein eigenes Deployment mit eigener Datenbank — kein
              gemeinsamer Mandantentopf. Updates rollen in Ringen aus: erst unsere
              eigene Instanz, dann ein Pilot, dann der Rest.
            </p>
            <div className="kette drei dunkel">
              {BETRIEB.map((b) => (
                <div key={b.nr}>
                  <p className="mono" style={{ margin: '0 0 10px' }}>{b.nr}</p>
                  <h3><span className={`punkt${b.kern ? ' kern' : ''}`} />{b.titel}</h3>
                  <p>{b.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="kosten">
          <div className="bahn">
            <Eyebrow text="Kosten" />
            <h2>Die Einführung ist der eigentliche Preis.</h2>
            <p className="lead">
              Bei klassischen ERP-Projekten zahlt man die Lizenz und danach das
              Anpassen: Beratungstage, Customizing, Schulung, Projektleitung. In KRNL
              entfällt der Customizing-Block — der Ablauf ist eine Version, kein
              Entwicklungsauftrag.
            </p>
            <div className="zwei kosten">
              <KostenRechner />
            </div>
          </div>
        </section>

        <section id="anmelden">
          <div className="bahn">
            <Eyebrow text="Registrierung" />
            <div className="zwei anmelden">
              <div>
                <h2>Erzählt uns euren Ablauf.</h2>
                <p className="lead">
                  Wir nehmen ihn im Gespräch auf und zeigen euch am selben Termin das
                  Diagramm. Wenn es stimmt, läuft es.
                </p>
                <ul className="statusliste">
                  <li><span className="punkt" /><span className="mono">Erstgespräch statt Workshop</span></li>
                  <li><span className="punkt kern" /><span className="mono">Diagramm am selben Termin</span></li>
                  <li><span className="punkt still" /><span className="mono">Eigene Instanz · Betrieb in der EU</span></li>
                </ul>
              </div>
              <Registrierung />
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="bahn">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <HexcoreMark groesse={18} variante="klein" />
            <Wortmarke groesse={15} />
            <span className="mono">Prozess-ERP</span>
          </span>
          <span className="mono">Betrieb in der EU · eigene Instanz je Kunde</span>
        </div>
      </footer>
    </div>
  )
}
