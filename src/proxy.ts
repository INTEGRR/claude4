import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Die Startseite liegt VOR dem Login: Wer die Wurzel ohne Sitzung aufruft,
 * sieht /start (was KRNL ist), nicht sofort das Anmeldeformular. Jede andere
 * geschützte Seite leitet weiterhin direkt zum Login — wer /verkauf aufruft,
 * will arbeiten, nicht lesen (der Redirect dafür sitzt im (erp)-Layout).
 *
 * Bewusst nur eine Cookie-Prüfung ohne Datenbank: Die Middleware entscheidet
 * hier nur über die Vorzimmertür. Ob die Sitzung wirklich gültig ist, prüft
 * wie bisher currentUser() serverseitig — ein abgelaufenes Cookie landet also
 * auf /login statt auf der Startseite, und das ist richtig so.
 *
 * Zieht die Startseite später in ein eigenes Vercel-Deployment um, fällt
 * diese Datei ersatzlos weg.
 *
 * Dateiname: Next 16 hat die Konvention `middleware` in `proxy` umbenannt
 * (die alte läuft noch, meldet aber eine Verwarnung). Funktion und Verhalten
 * sind identisch — nur Datei- und Exportname ändern sich.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has('erp_session')) {
    return NextResponse.redirect(new URL('/start', request.url))
  }
  return NextResponse.next()
}

export const config = { matcher: '/' }
