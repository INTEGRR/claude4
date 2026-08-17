import { sql } from '@/db/client'

/**
 * Boot-Splash (Design-Handoff „KRNL"): Hexcore-Logo, Schriftzug, Ladebalken —
 * einmal pro Sitzung beim Start der App (PWA wie Desktop), dann nie wieder.
 * Bewusst die cleane Fassung des Entwurfs: kein Bootlog, keine Scanlines,
 * kein ring-0-Beiwerk — Logo reißt beim Eintritt kurz auf und rastet ein
 * (ein Burst, dann Ruhe), der Balken läuft voll, das Ganze blendet aus.
 *
 * Die Kennzahlen sind echt: aktive Bereiche (Module) und aktive Prozesse aus
 * der Datenbank, als Siebensegment-Anzeige mit Geister-Achten dahinter.
 *
 * Technik: Server-gerendert und standardmäßig SICHTBAR (kein Blitzen der App
 * vor dem Splash); das Inline-Script direkt danach entfernt ihn vor dem
 * ersten Anstrich, wenn die Sitzung ihn schon gezeigt hat. Ausblenden und
 * Balken sind reines CSS — der Schriftzug hängt an keiner Animation
 * (Sichtbarkeit nie über opacity-Keyframes, siehe Handoff-Hinweis).
 */

function HexcoreMark() {
  return (
    <svg className="splash-mark" viewBox="0 0 100 100" fill="none" aria-hidden>
      <path
        d="M50 6 L88 28 L88 72 L50 94 L12 72 L12 28 Z"
        stroke="#F4F3EF"
        strokeWidth="6"
      />
      {/* Die Glitch-Signatur des Zeichens: zwei verrutschte Kanten. */}
      <path d="M50 6 L88 28" stroke="#FF5A1F" strokeWidth="6" transform="translate(6,-3)" />
      <path d="M12 72 L50 94" stroke="#7C5AFF" strokeWidth="6" transform="translate(-5,3)" />
      <rect x="42" y="42" width="16" height="16" fill="#FF5A1F" />
      <path
        d="M50 20 L50 42 M28 40 L42 50 M72 40 L58 50 M50 58 L50 78"
        stroke="#7C5AFF"
        strokeWidth="3"
      />
    </svg>
  )
}

function SiebenSegment({ wert, farbe }: { wert: number; farbe: 'signal' | 'kernel' }) {
  const text = String(wert)
  return (
    <span className={`splash-seg ${farbe}`}>
      <span className="splash-seg-geist" aria-hidden>
        {'8'.repeat(Math.max(text.length, 2))}
      </span>
      <span className="splash-seg-wert">{text}</span>
    </span>
  )
}

export async function Splash() {
  const [zahlen] = await sql<{ module: number; prozesse: number }[]>`
    select count(distinct bereich)::int as module, count(*)::int as prozesse
    from prozesse where aktiv`

  return (
    <>
      <div id="splash" className="splash" aria-hidden>
        <span className="splash-rail oben" />
        <div className="splash-buehne">
          <div className="splash-lockup">
            <HexcoreMark />
            <span className="splash-wortmarke">
              KRNL
              <span className="splash-geist violett" aria-hidden>KRNL</span>
              <span className="splash-geist orange" aria-hidden>KRNL</span>
            </span>
          </div>
          <div className="splash-untertitel">
            <span className="signal">▚</span> Enterprise Resource Kernel
          </div>
          <div className="splash-post">
            <div className="splash-post-zelle">
              <span className="splash-post-label">Module</span>
              <SiebenSegment wert={zahlen.module} farbe="signal" />
            </div>
            <div className="splash-post-zelle">
              <span className="splash-post-label">Prozesse</span>
              <SiebenSegment wert={zahlen.prozesse} farbe="kernel" />
            </div>
          </div>
          <div className="splash-balken">
            <span className="splash-balken-fuellung" />
          </div>
        </div>
        <span className="splash-rail unten" />
      </div>
      <script
        // Vor dem ersten Anstrich: Splash nur beim Sitzungsstart zeigen.
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var s=document.getElementById('splash');if(!s)return;if(sessionStorage.getItem('erp.splash')){s.remove()}else{sessionStorage.setItem('erp.splash','1');s.addEventListener('animationend',function(e){if(e.animationName==='splash-aus'){s.remove()}})}}catch(e){}})()`,
        }}
      />
    </>
  )
}
