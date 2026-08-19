import type { Metadata } from 'next'
import Link from 'next/link'
import { HexcoreMark, Wortmarke } from '@/components/marke'
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
 * Einstieg, Chamäleon (nur die eigenen Prozesse sind sichtbar), eigene
 * Instanz je Kunde. Keine erfundenen Referenzen oder Zahlen — was hier
 * steht, kann das System.
 */

export const metadata: Metadata = {
  title: 'KRNL — das ERP, das eurem Prozess folgt',
  description:
    'KRNL ist ein Prozess-ERP: Ihr diktiert euren Ablauf, KRNL setzt ihn um — '
    + 'ohne Entwicklung. Sprachgesteuert, deutsch, mit eigener Instanz je Kunde.',
}

// PLATZHALTER — vor dem Livegang durch die echte Kontaktadresse ersetzen.
// Bewusst sichtbar gehalten statt still eine erfundene Adresse zu verlinken.
const KONTAKT_MAIL = 'kontakt@example.com'

const BAUSTEINE = [
  {
    nr: '01',
    titel: 'Aufnehmen',
    text: 'Wir setzen uns mit euch hin, ihr erzählt euren Ablauf, wie er heute wirklich ist. '
      + 'Der Assistent hört zu, fragt nach Auslöser, Zuständigkeiten, Ausnahmen — und fasst zusammen.',
  },
  {
    nr: '02',
    titel: 'Zeichnen',
    text: 'Aus dem Gespräch entsteht ein Prozessdiagramm: Schritte, Entscheidungen, Abbruchwege. '
      + 'Ihr schaut drauf und sagt, was nicht stimmt. Das ist die Abnahme — kein Lastenheft.',
  },
  {
    nr: '03',
    titel: 'Läuft',
    text: 'Der freigegebene Ablauf wird geschaltet und ist ab dem Moment das System: '
      + 'Masken, Knöpfe und Navigation entstehen aus den Schritten. Keine Entwicklungsrunde dazwischen.',
  },
]

export default function StartSeite() {
  return (
    <div className="krnl-start">
      <header className="kopf">
        <div className="bahn">
          <Link href="/start" className="brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HexcoreMark groesse={26} variante="einfach" />
            <Wortmarke groesse={20} />
          </Link>
          <nav>
            <a className="weg-schmal" href="#prozess">Prozess First</a>
            <a className="weg-schmal" href="#sprechen">Sprechen</a>
            <a className="weg-schmal" href="#einstieg">Einstieg</a>
            <a className="weg-schmal" href="#betrieb">Betrieb</a>
            <Link className="taste" href="/login">Anmelden</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="held" style={{ borderTop: 'none' }}>
          <div className="bahn">
            <span className="marke-zeile"><span className="punkt" /> Prozess-ERP · deutsch · sprachgesteuert</span>
            <h1>Das ERP richtet sich nach eurem <em>Prozess</em>. Nicht umgekehrt.</h1>
            <p className="vorspann">
              In KRNL sind Abläufe keine Programmierung, sondern Daten. Ihr erzählt,
              wie bei euch gearbeitet wird — daraus entsteht ein Diagramm, und aus
              dem Diagramm wird die laufende Software. Ändert sich der Ablauf,
              ändert sich das System: am selben Tag, ohne Release.
            </p>
            <div className="knopfreihe">
              <Link className="taste fuehrend" href="/login">Zur Anmeldung</Link>
              <a className="taste" href="#einstieg">Wie ein Einstieg abläuft</a>
            </div>
          </div>
        </section>

        <section id="prozess">
          <div className="bahn">
            <p className="marke-klein">Prozess First</p>
            <h2>Standard-Software zwingt euch in fremde Abläufe.</h2>
            <p>
              Der übliche Weg: Man kauft ein ERP, danach beginnt das Anpassen —
              erst die Software, dann die Firma. KRNL dreht das um. Ein Prozess ist
              hier eine Version in der Datenbank, kein Sonderweg im Code.
            </p>
            <div className="gegen">
              <div className="sonst">
                <h3>Sonst</h3>
                <ul>
                  <li>Der Ablauf steckt in Masken und im Kopf der Entwicklung.</li>
                  <li>Jede Abweichung ist ein Anpassungsprojekt mit Angebot und Wartezeit.</li>
                  <li>Alle Kunden bekommen dieselbe Maske und lassen die Hälfte leer.</li>
                  <li>Niemand kann zeigen, wie der Ablauf im System tatsächlich aussieht.</li>
                </ul>
              </div>
              <div className="so">
                <h3>In KRNL</h3>
                <ul>
                  <li>Der Ablauf ist eine Prozessversion — sichtbar als Diagramm, jederzeit.</li>
                  <li>Schritte umbauen heißt: neue Version entwerfen, prüfen, schalten.</li>
                  <li>Jede Firma bekommt ihre eigenen Schritte, Zustände und Bezeichnungen.</li>
                  <li>Was der Ablauf nicht vorsieht, taucht in der Oberfläche gar nicht erst auf.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="sprechen">
          <div className="bahn">
            <p className="marke-klein">Sprechen</p>
            <h2>Der Einstieg ins System ist ein Gespräch.</h2>
            <p>
              Am Packtisch, im Lager, unterwegs: Tippen ist der Umweg. In KRNL ist
              Sprechen der Hauptzugang — mit Bestätigung vor jeder Buchung, weil
              ein ERP nichts stillschweigend verändern darf.
            </p>
            <div className="raster">
              <div className="kachel">
                <h3>Zählen ohne Zettel</h3>
                <p>
                  Inventur im Dialog: Artikel nennen, Menge sagen, weiter. Die Zählungen
                  sammeln sich in einer Prüftabelle und werden erst nach Sichtprüfung
                  gebucht — gesammelt, nicht im Vorbeigehen.
                </p>
              </div>
              <div className="kachel">
                <h3>Fragen statt Suchen</h3>
                <p>
                  „Wie viele Schalter sind noch da, und wann kommt Nachschub?" — die
                  Antwort kommt aus den echten Beständen und offenen Zuläufen, nicht
                  aus einem Bericht, den erst jemand bauen muss.
                </p>
              </div>
              <div className="kachel">
                <h3>Handeln mit Freigabe</h3>
                <p>
                  Auch Buchungen gehen per Zuruf — aber jede schreibende Aktion läuft
                  durch dieselbe Prüfung wie ein Klick: Rolle, Befugnis, Prozessschritt.
                  Die Stimme bekommt keine Sonderrechte.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="einstieg">
          <div className="bahn">
            <p className="marke-klein">Einstieg</p>
            <h2>Von eurem Ablauf zum laufenden System — in drei Schritten.</h2>
            <p>
              Kein monatelanges Einführungsprojekt: Der erste Termin ist kein Workshop
              über Software, sondern ein Gespräch über eure Arbeit.
            </p>
            <div className="kette">
              {BAUSTEINE.map((b, i) => (
                <div key={b.nr} className={`glied${i === 1 ? ' entscheidung' : ''}`}>
                  <span className="schritt">Schritt {b.nr}</span>
                  <strong>{b.titel}</strong>
                  <span className="text">{b.text}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="betrieb">
          <div className="bahn">
            <p className="marke-klein">Betrieb</p>
            <h2>Eure Daten liegen in eurer Instanz.</h2>
            <p>
              Jeder Kunde bekommt ein eigenes Deployment mit eigener Datenbank — kein
              gemeinsamer Mandantentopf. Updates rollen in Ringen aus: erst unsere
              eigene Instanz, dann ein Pilot, dann der Rest.
            </p>
            <div className="raster">
              <div className="kachel">
                <h3><span className="nr">01</span> Getrennt</h3>
                <p>
                  Eigene Datenbank je Kunde. Ein fehlerhaftes Update trifft höchstens
                  eine Instanz, und eine Wiederherstellung betrifft nur eure Daten.
                </p>
              </div>
              <div className="kachel">
                <h3><span className="nr">02</span> Rückholbar</h3>
                <p>
                  Point-in-Time-Recovery je Instanz, mit geprobter Wiederherstellung —
                  ein Backup, das nie zurückgespielt wurde, zählt nicht.
                </p>
              </div>
              <div className="kachel">
                <h3><span className="nr">03</span> Geprüft</h3>
                <p>
                  Ein nächtlicher Daten-TÜV rechnet Bestände, Reservierungen und
                  Wertschichten gegen das Bewegungsjournal. Abweichungen schlagen
                  Alarm, statt still weiterzulaufen.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="abschluss">
          <div className="bahn">
            <h2>Erzählt uns euren Ablauf.</h2>
            <p>
              Wir nehmen ihn im Gespräch auf und zeigen euch am selben Termin das
              Diagramm. Wenn es stimmt, läuft es.
            </p>
            <div className="knopfreihe">
              <Link className="taste fuehrend" href="/login">Zur Anmeldung</Link>
              <a className="taste" href={`mailto:${KONTAKT_MAIL}`}>Termin anfragen</a>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="bahn">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HexcoreMark groesse={18} variante="klein" />
            KRNL — Prozess-ERP
          </span>
          <span>Betrieb in der EU · eigene Instanz je Kunde</span>
        </div>
      </footer>
    </div>
  )
}
