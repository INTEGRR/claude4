import { sql, tx } from '@/db/client'
import { REGISTRY } from './index.ts'
import { JOB_KATALOG } from '../jobs-katalog.ts'
import { EREIGNISSE } from '../ereignisse.ts'
import { entwurfPruefen } from '../entwurf-pruefen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Prozess-Verwaltungsaktionen. */

// --- Einrichtung (Onboarding) ----------------------------------------------

export async function firmaSpeichern(
  p: {
    name: string
    street: string
    house: string
    zip: string
    city: string
    country: string
    email: string
    phone: string
  },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update settings set value = ${sql.json(p)} where key = 'company'`
  return { text: `Firmendaten von „${p.name}" gespeichert.` }
}

export async function demodatenEinspielenAktion(
  _p: Record<string, never>,
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Das Demodaten-Modul ist bewusst skriptfähig (kein server-only) und
  // wirft selbst, wenn schon Produkte existieren — Idempotenz-Wächter.
  const { demodatenEinspielen } = await import('@/modules/demo/daten')
  const zeilen = await demodatenEinspielen(sql)
  return {
    text: `Beispieldaten eingespielt (${zeilen.length} Bausteine) — Rundgang: docs/lokal-starten.md.`,
  }
}

export async function einrichtungAbschliessen(
  p: { modus: 'demo' | 'gefuehrt' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into settings (key, value)
    values ('einrichtung', ${sql.json({
      abgeschlossen: true,
      modus: p.modus,
      am: new Date().toISOString(),
      durch: ctx.actor,
    })})
    on conflict (key) do update set value = excluded.value`
  return { text: 'Einrichtung abgeschlossen — willkommen in KRNL.' }
}

export async function prozessschrittSchalten(
  p: { prozess_code: string; schritt_code: string; aktiv: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [schritt] = await sql<{ optional: boolean; name: string }[]>`
    select s.optional, s.name from prozess_schritte s
    where s.version_id = prozess_aktive_version(${p.prozess_code})
      and s.code = ${p.schritt_code}`
  if (!schritt) {
    throw new Error(
      `Schritt „${p.schritt_code}" existiert nicht in der aktiven Version von ${p.prozess_code}.`,
    )
  }
  if (!p.aktiv && !schritt.optional) {
    throw new Error('Nur optionale Schritte lassen sich abschalten.')
  }

  await sql`
    insert into prozess_overrides (prozess_code, schritt_code, aktiv, geaendert_von)
    values (${p.prozess_code}, ${p.schritt_code}, ${p.aktiv}, ${ctx.actor})
    on conflict (prozess_code, schritt_code)
    do update set aktiv = excluded.aktiv, geaendert_von = excluded.geaendert_von`

  return {
    text: `„${schritt.name}" ist jetzt ${p.aktiv ? 'aktiv' : 'abgeschaltet'}.`,
    recordId: p.prozess_code,
  }
}

export async function prozessSchalten(
  p: { prozess_code: string; aktiv: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  if (p.prozess_code === 'bug_ticket' && !p.aktiv) {
    throw new Error('Der Bug-Loop ist Infrastruktur und lässt sich nicht abschalten.')
  }
  // Konsistenz-Wächter: solange ein aktiver Elternprozess diesen Prozess als
  // Teilprozess einbindet, würde das Abschalten dessen Ablauf mitten
  // durchtrennen — der Elternschritt würde nie fertig.
  if (!p.aktiv) {
    const eltern = await sql<{ code: string; schritt: string }[]>`
      select e.code, s.code as schritt
      from prozesse e
      join prozess_schritte s on s.version_id = prozess_aktive_version(e.code)
      where e.aktiv and s.art = 'prozess' and s.teilprozess = ${p.prozess_code}
      order by e.code`
    if (eltern.length > 0) {
      throw new Error(
        `„${p.prozess_code}" ist Teilprozess von ` +
          eltern.map((e) => `${e.code} (Schritt „${e.schritt}")`).join(', ') +
          ' — erst den Elternprozess abschalten oder den Schritt aus dessen Version nehmen.',
      )
    }
  }
  const [prozess] = await sql<{ name: string }[]>`
    update prozesse set aktiv = ${p.aktiv}
    where code = ${p.prozess_code}
    returning name`
  if (!prozess) throw new Error(`Prozess „${p.prozess_code}" existiert nicht.`)

  // Einschalten zieht die eigenen Teilprozesse (transitiv) mit — ein aktiver
  // Prozess referenziert nie einen abgeschalteten.
  let mitgezogen: string[] = []
  if (p.aktiv) {
    mitgezogen = (
      await sql<{ code: string }[]>`
        with recursive kinder(code) as (
          select s.teilprozess from prozess_schritte s
          where s.version_id = prozess_aktive_version(${p.prozess_code})
            and s.art = 'prozess' and s.teilprozess is not null
          union
          select s2.teilprozess
          from kinder k
          join prozess_schritte s2 on s2.version_id = prozess_aktive_version(k.code)
          where s2.art = 'prozess' and s2.teilprozess is not null
        )
        update prozesse set aktiv = true
        where code in (select code from kinder) and not aktiv
        returning code`
    ).map((r) => r.code)
  }

  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Prozess ${p.prozess_code} ${p.aktiv ? 'aktiviert' : 'abgeschaltet'}` +
      (mitgezogen.length > 0 ? ` (Teilprozesse mit: ${mitgezogen.join(', ')})` : '')}, ${ctx.actor})`
  return {
    text:
      `„${prozess.name}" ist jetzt ${p.aktiv ? 'aktiv' : 'abgeschaltet'}.` +
      (mitgezogen.length > 0
        ? ` Teilprozesse mit aktiviert: ${mitgezogen.join(', ')}.`
        : ''),
    recordId: p.prozess_code,
  }
}

export async function paketAktivieren(
  p: { paket_code: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [paket] = await sql<{ name: string; prozess_codes: string[] }[]>`
    select name, prozess_codes from prozess_pakete where code = ${p.paket_code}`
  if (!paket) throw new Error(`Paket „${p.paket_code}" existiert nicht.`)

  // Konsistenz-Wächter: Teilprozess-Kanten transitiv mitziehen — ein Paket,
  // das den Einkauf nennt, bekommt Wareneingang und Lieferantenrechnung
  // automatisch dazu, statt sie stumm abzuschalten.
  const geschlossen = (
    await sql<{ code: string }[]>`
      with recursive ziel(code) as (
        select unnest(${paket.prozess_codes}::text[])
        union
        select s.teilprozess
        from ziel z
        join prozess_schritte s on s.version_id = prozess_aktive_version(z.code)
        where s.art = 'prozess' and s.teilprozess is not null
      )
      select code from ziel`
  ).map((r) => r.code)
  const mitgezogen = geschlossen.filter((c) => !paket.prozess_codes.includes(c))

  // Pivot = Paketwechsel: exakt die Paket-Prozesse (plus Abhängigkeiten) an,
  // der Rest aus. bug_ticket ist Infrastruktur und bleibt in jedem
  // Geschäftsmodell an.
  await sql`
    update prozesse
    set aktiv = (code = any(${geschlossen}) or code = 'bug_ticket')`

  // Weicher Blick auf Querbezüge: nutzt ein aktiver Prozessschritt eine
  // Aktion aus einem Bereich ohne aktiven Prozess, laufen die dort erzeugten
  // Belege ohne Prozessbegleitung. Kein Fehler — aber es steht im Ergebnis.
  const schritte = await sql<{ prozess: string; schritt: string; aktion: string }[]>`
    select pr.code as prozess, s.code as schritt, s.aktion
    from prozesse pr
    join prozess_schritte s on s.version_id = prozess_aktive_version(pr.code)
    where pr.aktiv and s.aktion is not null`
  const aktiveBereiche = new Set(
    (await sql<{ bereich: string }[]>`
      select distinct bereich from prozesse where aktiv`).map((b) => b.bereich),
  )
  const querbezuege = schritte.filter((s) => {
    const eintrag = (REGISTRY as Record<string, { bereich?: string }>)[s.aktion]
    return eintrag?.bereich !== undefined && !aktiveBereiche.has(eintrag.bereich)
  })

  const aktive = await sql<{ code: string }[]>`
    select code from prozesse where aktiv order by code`
  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Paket ${p.paket_code} aktiviert: ${aktive.map((a) => a.code).join(', ')}` +
      (mitgezogen.length > 0 ? ` (Teilprozesse mit: ${mitgezogen.join(', ')})` : '')}, ${ctx.actor})`
  return {
    text:
      `Paket „${paket.name}" aktiviert — aktive Prozesse: ${aktive
        .map((a) => a.code)
        .join(', ')}.` +
      (mitgezogen.length > 0
        ? ` Teilprozesse automatisch mit aktiviert: ${mitgezogen.join(', ')}.`
        : '') +
      (querbezuege.length > 0
        ? ` Hinweis: ${querbezuege
            .slice(0, 5)
            .map((q) => `${q.prozess}/${q.schritt} nutzt ${q.aktion}`)
            .join('; ')} — der Zielbereich hat keinen aktiven Prozess, Belege daraus laufen ohne Prozessbegleitung.`
        : ''),
    recordId: p.paket_code,
  }
}

// --- Prozessentwurf (KI entwirft, Mensch aktiviert) --------------------------

interface EntwurfSchritt {
  code: string
  name: string
  art: 'start' | 'aktion' | 'dienst' | 'ereignis' | 'prozess' | 'xor' | 'ende'
  aktion?: string
  job_kind?: string
  ereignis?: string
  teilprozess?: string
  teilprozess_link?: Record<string, unknown>
  zustand?: string
  rollen?: string[]
  befugnis?: string
  params?: Record<string, unknown>
  optional: boolean
}

/**
 * Ein eigenes Feld, das MIT dem Prozess entsteht — der zweite Teil eines
 * Ablaufs neben den Schritten. Ohne das hier bekäme ein Kunde, der seinen
 * Prozess aufnimmt, zwar Maske und Navigation geschenkt, müsste die Daten
 * darin aber von Hand nachtragen.
 */
export interface EntwurfFeld {
  name: string
  label: string
  typ: 'text' | 'nummer' | 'schalter' | 'auswahl' | 'datum'
  pflicht: boolean
  auswahl?: string[]
  schritte?: string[]
  in_liste: boolean
}

/**
 * Beleg-Aktionen mit fremdem Modell, die TROTZDEM in einem Schritt stehen
 * dürfen — geschlossene, begründete Liste (Muster UI_UMGEHUNGEN). Heute leer:
 * Der bekannte Weg über Belege hinweg ist der Teilprozess, nicht die
 * Fremdaktion.
 */
const FREMDMODELL_AUSNAHMEN = new Set<string>([])

export async function prozessEntwerfen(
  p: {
    code: string
    name: string
    beschreibung?: string
    bereich: string
    modell?: string
    schritte: EntwurfSchritt[]
    uebergaenge: { von: string; nach: string; bedingung?: unknown; beschriftung?: string }[]
    felder?: EntwurfFeld[]
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Struktur früh und verständlich prüfen — MIT den Regeln, an denen die
  // Aktivierung später scheitern würde (BUG/00015: die KI baute einen
  // XOR-Schritt mit zwei bedingungslosen Kanten; der Entwurf entstand
  // klaglos und ließ sich danach nie aktivieren). Ein Entwurf, der nicht
  // aktivierbar ist, ist kein Entwurf — er ist eine Falle. Dieselben Regeln
  // stehen hart in prozess_version_aktivieren; hier sagen sie es dem
  // Entwerfenden (auch der KI, die daraufhin nachbessern kann).
  const starts = p.schritte.filter((s) => s.art === 'start').length
  if (starts !== 1) {
    throw new Error(`Ein Prozess braucht genau einen Startschritt (der Entwurf hat ${starts}).`)
  }
  if (!p.schritte.some((s) => s.art === 'ende')) {
    throw new Error('Ein Prozess braucht mindestens einen Endschritt.')
  }
  const codes = new Set(p.schritte.map((s) => s.code))
  if (codes.size !== p.schritte.length) {
    throw new Error('Schritt-Codes müssen eindeutig sein.')
  }
  // Effektives Modell: bei bestehenden Prozessen zählt der Bestand — das
  // Feld modell wird beim Umbau meist weggelassen (und darf ohnehin nicht
  // wechseln, siehe unten).
  const [bestand] = await sql<{ modell: string | null }[]>`
    select modell from prozesse where code = ${p.code}`
  const effektivesModell = bestand ? bestand.modell : (p.modell ?? null)
  for (const s of p.schritte) {
    if (s.art === 'aktion' && !s.aktion) {
      throw new Error(`Schritt „${s.code}": art=aktion braucht eine registrierte Aktion.`)
    }
    if (s.aktion && !(s.aktion in REGISTRY)) {
      throw new Error(
        `Schritt „${s.code}": unbekannte Aktion „${s.aktion}" — der Katalog steht auf /prozesse.`,
      )
    }
    if (s.art === 'dienst' && !s.job_kind) {
      throw new Error(`Schritt „${s.code}": art=dienst braucht einen job_kind aus dem Katalog.`)
    }
    if (s.job_kind && !(s.job_kind in JOB_KATALOG)) {
      throw new Error(
        `Schritt „${s.code}": unbekannter Job „${s.job_kind}" — der Katalog steht auf /prozesse (Dienste).`,
      )
    }
    if (s.art === 'ereignis' && !s.ereignis) {
      throw new Error(`Schritt „${s.code}": art=ereignis braucht ein Topic aus dem Katalog.`)
    }
    if (s.ereignis && !(s.ereignis in EREIGNISSE)) {
      throw new Error(
        `Schritt „${s.code}": unbekanntes Ereignis „${s.ereignis}" — der Katalog steht auf /prozesse (Ereignisse).`,
      )
    }
    // Zustandsführende Vorgangs-Aktionen brauchen einen zustand. Ohne ihn
    // landet der Beleg außerhalb des Diagramms (Notnagel 'neu' beim Anlegen,
    // ein unbekannter state beim Weiterschalten) — das Panel kann den
    // Vorgang dann nicht verorten, und die Traversierung läuft nie über
    // Aktionsknoten hinweg: der Schritt wäre eine Sackgasse. Genau so ist
    // der erste Kundenprozess entstanden. kopf_aendern ist bewusst außen
    // vor: es pflegt Daten und bewegt nichts.
    const ZUSTANDSFUEHREND = ['vorgang.anlegen', 'vorgang.status_setzen', 'vorgang.auftrag_anlegen']
    if (s.aktion && ZUSTANDSFUEHREND.includes(s.aktion) && !s.zustand) {
      throw new Error(
        `Schritt „${s.code}": ${s.aktion} braucht einen zustand — er verortet den ` +
          'Vorgang auf dem Diagramm (und muss zu params.state passen, falls gesetzt).',
      )
    }
    const paramsState = (s.params as { state?: unknown } | undefined)?.state
    if (s.zustand && typeof paramsState === 'string' && paramsState !== s.zustand) {
      throw new Error(
        `Schritt „${s.code}": zustand „${s.zustand}" und params.state „${paramsState}" ` +
          'widersprechen sich — beide müssen denselben Wert tragen.',
      )
    }
    // Fremde Beleg-Aktionen gehören in einen Teilprozess, nicht in einen
    // Schritt: die Oberfläche sendet auf einer Belegseite IMMER die ID des
    // eigenen Belegs — eine Aktion mit anderem Modell bekäme die falsche ID
    // und scheiterte erst zur Laufzeit am Torwächter (Modellprüfung 0072).
    if (s.art === 'aktion' && s.aktion) {
      const eintrag = REGISTRY[s.aktion as keyof typeof REGISTRY] as
        | { bindung?: string; modell?: string }
        | undefined
      if (
        eintrag?.bindung === 'beleg' &&
        eintrag.modell &&
        eintrag.modell !== effektivesModell &&
        !FREMDMODELL_AUSNAHMEN.has(s.aktion)
      ) {
        throw new Error(
          `Schritt „${s.code}": „${s.aktion}" arbeitet auf ${eintrag.modell}, der Prozess ` +
            `auf ${effektivesModell ?? 'keinem Beleg (beleglos)'} — fremde Belegaktionen ` +
            "gehören in einen Teilprozess (art 'prozess'), nicht in einen Aktionsschritt.",
        )
      }
    }
    if (s.art === 'prozess') {
      if (!s.teilprozess) {
        throw new Error(`Schritt „${s.code}": art=prozess braucht einen teilprozess (Kindprozess-Code).`)
      }
      if (s.teilprozess === p.code) {
        throw new Error(`Schritt „${s.code}": ein Prozess kann nicht sein eigener Teilprozess sein.`)
      }
    }
  }
  // Teilprozess-Verweise gegen die Datenbank prüfen — verständlich hier,
  // hart noch einmal in prozess_version_aktivieren (0072). Der TS-Spiegel
  // existiert, damit die KI den Fehler schon in der Entwurfsrunde bekommt
  // und nachbessern kann, statt dass die Aktivierung Tage später scheitert.
  for (const s of p.schritte) {
    if (s.art !== 'prozess' || !s.teilprozess) continue
    const [kind] = await sql<{ code: string; modell: string | null }[]>`
      select code, modell from prozesse where code = ${s.teilprozess}`
    if (!kind) {
      throw new Error(
        `Schritt „${s.code}": Teilprozess „${s.teilprozess}" existiert nicht — die Liste steht auf /prozesse.`,
      )
    }
    // Verkettbarkeit: teilprozess_stand findet Kindbelege über origin-Spalten
    // oder die teilprozess_link-Spalte — fehlt beides, wartet der Schritt für
    // immer. Die Fehlermeldung benennt, was einem Beleg zur Verkettbarkeit
    // fehlt: so erklärt das System die Regel selbst.
    if (!effektivesModell) {
      throw new Error(
        `Schritt „${s.code}": der Prozess ist beleglos — ohne Elternbeleg kann kein ` +
          'Kindbeleg an ihm hängen (Teilprozesse brauchen ein modell).',
      )
    }
    if (!kind.modell) {
      throw new Error(
        `Schritt „${s.code}": „${s.teilprozess}" ist beleglos — ein Teilprozess braucht ` +
          'einen Beleg, der am Elternbeleg hängen kann.',
      )
    }
    const linkSpalte = (s.teilprozess_link as { spalte?: unknown } | undefined)?.spalte
    const [verkettbar] = await sql<{ ok: boolean }[]>`
      select case
        when ${typeof linkSpalte === 'string' ? linkSpalte : null}::text is not null then exists (
          select 1 from pg_attribute
          where attrelid = to_regclass((select tabelle from prozess_modelle where modell = ${kind.modell}))
            and attname = ${typeof linkSpalte === 'string' ? linkSpalte : null} and not attisdropped)
        else exists (
          select 1 from pg_attribute
          where attrelid = to_regclass((select tabelle from prozess_modelle where modell = ${kind.modell}))
            and attname = 'origin_model' and not attisdropped)
      end as ok`
    if (!verkettbar?.ok) {
      throw new Error(
        typeof linkSpalte === 'string'
          ? `Schritt „${s.code}": die Tabelle des Belegs „${kind.modell}" hat keine Spalte „${linkSpalte}" (teilprozess_link).`
          : `Schritt „${s.code}": Belege „${s.teilprozess}" (${kind.modell}) können nicht am ` +
              'Elternbeleg hängen — der Tabelle fehlen origin_model/origin_id, und ein ' +
              'teilprozess_link {"spalte": …} ist nicht gesetzt.',
      )
    }
  }
  for (const u of p.uebergaenge) {
    if (!codes.has(u.von) || !codes.has(u.nach)) {
      throw new Error(`Übergang ${u.von} → ${u.nach}: beide Enden müssen Schritt-Codes sein.`)
    }
  }

  // Felder gegen die Schritte prüfen — ein Feld, das auf einen Schritt zeigt,
  // den es nicht gibt, wäre in keiner Maske sichtbar und würde stumm fehlen.
  const feldNamen = new Set<string>()
  for (const f of p.felder ?? []) {
    if (feldNamen.has(f.name)) {
      throw new Error(`Feld „${f.name}" ist doppelt — Feldnamen müssen eindeutig sein.`)
    }
    feldNamen.add(f.name)
    if (f.typ === 'auswahl' && !f.auswahl?.length) {
      throw new Error(`Feld „${f.name}": typ=auswahl braucht die Werte in auswahl[].`)
    }
    for (const s of f.schritte ?? []) {
      if (!codes.has(s)) {
        throw new Error(
          `Feld „${f.name}": Schritt „${s}" gibt es nicht — schritte[] nennt Schritt-Codes ` +
            'dieses Entwurfs (leer lassen = in jedem Schritt sichtbar).',
        )
      }
    }
  }

  // Dieselben Strukturregeln, die prozess_version_aktivieren hart prüft —
  // hier schon beim Entwurf (entwurf-pruefen.ts, pur und einzeln getestet).
  const strukturfehler = entwurfPruefen(
    p.schritte.map((s) => ({ code: s.code, art: s.art })),
    p.uebergaenge.map((u) => ({ von: u.von, nach: u.nach, bedingung: u.bedingung })),
  )
  if (strukturfehler) throw new Error(strukturfehler)

  const version = await tx(async (t) => {
    const [vorhanden] = await t<{ id: string; modell: string | null }[]>`
      select id, modell from prozesse where code = ${p.code}`
    let prozessId: string
    let modell: string | null = p.modell ?? null
    if (vorhanden) {
      // Umbau eines bestehenden Prozesses (beliebiges Modell): die neue
      // Version erbt den Beleg — ein angegebenes modell muss dazu passen.
      if (p.modell !== undefined && (vorhanden.modell ?? null) !== p.modell) {
        throw new Error(
          `Prozess „${p.code}" existiert mit anderem Beleg (${vorhanden.modell ?? 'beleglos'}) — ` +
            'ein Entwurf kann das Modell nicht wechseln (Feld modell weglassen).',
        )
      }
      prozessId = vorhanden.id
      modell = vorhanden.modell
    } else {
      // Neue Prozesse: nur Laufzeit-Belege (vorgang) oder beleglos — an
      // Fachtabellen gebundene Prozesse entstehen nicht per Entwurf.
      if (p.modell && p.modell !== 'vorgang') {
        throw new Error(
          `Neue Prozesse entstehen nur mit modell 'vorgang' oder ohne Modell — ` +
            `„${p.modell}" ist eine Fachtabelle.`,
        )
      }
      // Neue Prozesse entstehen INAKTIV — sichtbar werden sie erst, wenn ein
      // Mensch eine Version aktiviert (das setzt auch prozesse.aktiv).
      const [neu] = await t<{ id: string }[]>`
        insert into prozesse (code, name, beschreibung, bereich, modell, aktiv)
        values (${p.code}, ${p.name}, ${p.beschreibung ?? null}, ${p.bereich},
                ${p.modell ?? null}, false)
        returning id`
      prozessId = neu.id
    }

    const [{ nr }] = await t<{ nr: number }[]>`
      select coalesce(max(version), 0) + 1 as nr
      from prozess_versionen where prozess_id = ${prozessId}`
    const [v] = await t<{ id: string }[]>`
      insert into prozess_versionen (prozess_id, version, status, created_by)
      values (${prozessId}, ${nr}, 'entwurf', ${ctx.actor})
      returning id`

    // jsonb-Werte gehen über t.json(), NICHT über JSON.stringify(…)::jsonb.
    // Der Treiber verpackt einen String noch einmal als JSON — gespeichert
    // wird dann ein JSON-STRING statt eines Objekts ("{\"a\":1}" statt
    // {"a":1}). Das ist unsichtbar, bis jemand das Feld benutzt: die
    // Vorgangsmaske prüfte `'partner_id' in params` und bekam einen
    // TypeError (die Detailseite lief auf einen Fehler), und
    // bedingung_pruefen sah einen String statt einer Bedingung — die
    // XOR-Zweige aller KI-entworfenen Prozesse griffen also nie.
    for (const [i, s] of p.schritte.entries()) {
      await t`
        insert into prozess_schritte (version_id, code, name, art, sequence, aktion,
                                      job_kind, ereignis, teilprozess, teilprozess_link,
                                      zustand, rollen, befugnis, params, optional)
        values (${v.id}, ${s.code}, ${s.name}, ${s.art}, ${i * 10}, ${s.aktion ?? null},
                ${s.job_kind ?? null}, ${s.ereignis ?? null},
                ${s.teilprozess ?? null},
                ${s.teilprozess_link ? t.json(s.teilprozess_link as never) : null},
                ${s.zustand ?? null}, ${s.rollen ?? null}, ${s.befugnis ?? null},
                ${t.json((s.params ?? {}) as never)}, ${s.optional})`
    }
    for (const [i, u] of p.uebergaenge.entries()) {
      await t`
        insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence,
                                         bedingung, beschriftung)
        values (${v.id}, ${u.von}, ${u.nach}, ${(i + 1) * 10},
                ${u.bedingung == null ? null : t.json(u.bedingung as never)},
                ${u.beschriftung ?? null})`
    }

    // Die Felder des Prozesses (Migration 0071). Sie hängen am PROZESS, nicht
    // an der Version: die erfassten Werte stehen im zusatz-jsonb der Belege
    // und überleben jeden Versionswechsel. Deshalb wird hier auch nur
    // ergänzt/aktualisiert — ein Feld, das die neue Version nicht mehr nennt,
    // bleibt stehen (sonst verlöre die Liste rückwirkend ihre Spalten).
    // Aufräumen ist ein bewusster eigener Schritt: einstellungen.feld_loeschen.
    if (p.felder?.length) {
      if (!modell) {
        throw new Error(
          'Eigene Felder brauchen einen Beleg — ein belegloser Assistent hat nichts, ' +
            "worin sie stehen könnten (modell 'vorgang' setzen oder felder weglassen).",
        )
      }
      for (const [i, f] of p.felder.entries()) {
        await t`
          insert into feld_definitionen
            (modell, prozess_code, name, label, typ, pflicht, auswahl, schritte,
             sichtbar_in, sequence)
          values (${modell}, ${p.code}, ${f.name}, ${f.label}, ${f.typ}, ${f.pflicht},
                  ${f.auswahl?.length ? f.auswahl : null},
                  ${f.schritte?.length ? f.schritte : null},
                  ${f.in_liste ? ['formular', 'liste'] : ['formular']}, ${(i + 1) * 10})
          on conflict (modell, (coalesce(prozess_code, '')), name) do update
            set label = excluded.label, typ = excluded.typ, pflicht = excluded.pflicht,
                auswahl = excluded.auswahl, schritte = excluded.schritte,
                sichtbar_in = excluded.sichtbar_in, sequence = excluded.sequence`
      }
    }
    return nr
  })

  const felderText = p.felder?.length ? `, ${p.felder.length} Felder` : ''
  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Prozessentwurf ${p.code} v${version} (${p.schritte.length} Schritte${felderText})`}, ${ctx.actor})`
  return {
    text:
      `Entwurf gespeichert: ${p.code} Version ${version}${felderText} — Diagramm prüfen ` +
      'und dann bewusst aktivieren.',
    recordId: p.code,
    link: `/prozesse/${p.code}?version=${version}`,
  }
}

export async function prozessversionAktivieren(
  p: { prozess_code: string; version: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [v] = await sql<{ id: string; status: string }[]>`
    select v.id, v.status
    from prozess_versionen v
    join prozesse p on p.id = v.prozess_id
    where p.code = ${p.prozess_code} and v.version = ${p.version}`
  if (!v) throw new Error(`Version ${p.version} von „${p.prozess_code}" existiert nicht.`)
  if (v.status === 'aktiv') throw new Error('Diese Version ist bereits aktiv.')

  // Die DB-Funktion validiert (Start/Ende, erreichbar, azyklisch, XOR,
  // eindeutige Zustände) und archiviert die bisher aktive Version.
  await sql`select prozess_version_aktivieren(${v.id})`
  await sql`update prozesse set aktiv = true where code = ${p.prozess_code}`
  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Prozessversion aktiviert: ${p.prozess_code} v${p.version}`}, ${ctx.actor})`
  return {
    text: `„${p.prozess_code}" läuft jetzt mit Version ${p.version}.`,
    recordId: p.prozess_code,
  }
}

// --- Eigene Felder (Chamäleon) -----------------------------------------------

export async function feldAnlegen(
  p: {
    modell: string
    name: string
    label: string
    typ: string
    pflicht: boolean
    auswahl?: string[]
    prozess_code?: string
    schritte?: string[]
    in_liste?: boolean
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Der Regelweg ist der Prozessentwurf (felder[] in prozess_entwerfen) — das
  // hier ist der Nachtrag von Hand, für ein einzelnes Feld oder für Felder am
  // ganzen Modell (prozess_code leer, z. B. ein Feld an ALLEN Kontakten).
  await sql`
    insert into feld_definitionen
      (modell, prozess_code, name, label, typ, pflicht, auswahl, schritte, sichtbar_in)
    values (${p.modell}, ${p.prozess_code ?? null}, ${p.name}, ${p.label}, ${p.typ},
            ${p.pflicht}, ${p.auswahl?.length ? p.auswahl : null},
            ${p.schritte?.length ? p.schritte : null},
            ${p.in_liste ? ['formular', 'liste'] : ['formular']})
    on conflict (modell, (coalesce(prozess_code, '')), name) do update
      set label = excluded.label, typ = excluded.typ, pflicht = excluded.pflicht,
          auswahl = excluded.auswahl, schritte = excluded.schritte,
          sichtbar_in = excluded.sichtbar_in`
  const wo = p.prozess_code ? `${p.prozess_code}.${p.name}` : `${p.modell}.${p.name}`
  await sql`select log_event('feld_definition', gen_random_uuid(), 'state',
    ${`Eigenes Feld: ${wo} (${p.typ})`}, ${ctx.actor})`
  return { text: `Feld ${wo} angelegt.` }
}

export async function feldLoeschen(p: {
  modell: string
  name: string
  prozess_code?: string
}): Promise<AktionsErgebnis> {
  await sql`
    delete from feld_definitionen
    where modell = ${p.modell} and name = ${p.name}
      and coalesce(prozess_code, '') = ${p.prozess_code ?? ''}`
  const wo = p.prozess_code ? `${p.prozess_code}.${p.name}` : `${p.modell}.${p.name}`
  return { text: `Feld ${wo} entfernt — erfasste Werte bleiben im zusatz stehen.` }
}

// --- Benutzerverwaltung ------------------------------------------------------

/** Wirft, wenn nach der Änderung kein aktiver Administrator übrig bliebe. */
async function guardLetzterAdmin(userId: string): Promise<void> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from users
    where role = 'admin' and active and id <> ${userId}`
  if (Number(row.count) === 0) {
    throw new Error('Der letzte aktive Administrator kann nicht entfernt werden')
  }
}

/**
 * hashPassword kommt aus dem Auth-Modul, das next/headers zieht — deshalb
 * dynamisch importiert: der Katalog bleibt unter blankem Node ladbar, nur
 * die tatsächliche Ausführung braucht die Next-Umgebung.
 */
async function passwortHashen(password: string): Promise<string> {
  const { hashPassword } = await import('@/modules/auth')
  return hashPassword(password)
}

export async function benutzerAnlegen(
  p: { email: string; name: string; password: string; role: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, name, password_hash, role)
    values (${p.email}, ${p.name}, ${await passwortHashen(p.password)}, ${p.role})
    on conflict (email) do nothing
    returning id`
  if (!row) throw new Error('Diese E-Mail-Adresse ist bereits vergeben')

  await sql`select log_event('user', ${row.id}, 'state',
    ${'Benutzer angelegt (' + p.role + ')'}, ${ctx.actor})`
  return { text: `Benutzer ${p.email} angelegt.`, recordId: row.id }
}

export async function benutzerRolle(
  p: { role: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  if (p.role !== 'admin') await guardLetzterAdmin(userId)

  await sql`update users set role = ${p.role} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${'Rolle geändert auf ' + p.role}, ${ctx.actor})`
  return { recordId: userId }
}

export async function benutzerAktiv(
  p: { active: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  if (!p.active) {
    await guardLetzterAdmin(userId)
    // Laufende Sitzungen des deaktivierten Kontos sofort beenden.
    await sql`delete from sessions where user_id = ${userId}`
  }
  await sql`update users set active = ${p.active} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${p.active ? 'Benutzer aktiviert' : 'Benutzer deaktiviert'}, ${ctx.actor})`
  return { recordId: userId }
}

export async function benutzerBefugnisse(
  p: { befugnisse: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  await sql`update users set befugnisse = ${p.befugnisse} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${p.befugnisse.length > 0
      ? 'Befugnisse gesetzt: ' + p.befugnisse.join(', ')
      : 'Alle Befugnisse entzogen'}, ${ctx.actor})`
  return { recordId: userId }
}

export async function benutzerPasswort(
  p: { password: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  await sql`update users set password_hash = ${await passwortHashen(p.password)}
            where id = ${userId}`
  await sql`delete from sessions where user_id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state', 'Passwort zurückgesetzt', ${ctx.actor})`
  return { recordId: userId }
}

// --- Registrierungen von der öffentlichen Startseite ------------------------

export async function registrierungStatus(
  p: { status: string; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [zeile] = await sql<{ firma: string }[]>`
    update registrierungen
       set status = ${p.status},
           notiz = coalesce(${p.notiz ?? null}, notiz),
           bearbeitet_am = now(),
           bearbeitet_durch = ${ctx.actor}
     where id = ${id}
    returning firma`
  if (!zeile) throw new Error('Diese Registrierung gibt es nicht (mehr)')

  await sql`select log_event('registrierung', ${id}, 'state',
    ${`Stand: ${p.status}`}, ${ctx.actor})`
  return { text: `${zeile.firma} → ${p.status}.`, recordId: id }
}

// --- Abnahme einer Prozessversion -------------------------------------------

export async function prozessAbnahme(
  p: { prozess_code: string; version: number; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [zeile] = await sql<{ id: string; prozess_id: string }[]>`
    update prozess_versionen v
       set abnahme_am = now(),
           abnahme_durch = ${ctx.actor},
           abnahme_notiz = ${p.notiz ?? null}
      from prozesse pr
     where v.prozess_id = pr.id
       and pr.code = ${p.prozess_code}
       and v.version = ${p.version}
    returning v.id, v.prozess_id`
  if (!zeile) throw new Error(`Version ${p.version} von „${p.prozess_code}" gibt es nicht`)

  await sql`select log_event('prozess_version', ${zeile.id}, 'state',
    ${`Diagramm abgenommen (Version ${p.version})`}, ${ctx.actor})`
  return {
    text: `Abnahme für „${p.prozess_code}" Version ${p.version} protokolliert.`,
    recordId: p.prozess_code,
  }
}

// --- Gefahrenzone -----------------------------------------------------------

export async function betriebsdatenLoeschen(
  _p: { bestaetigung: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select demodaten_loeschen()`
  await sql`select log_event('system', gen_random_uuid(), 'state',
    'Betriebsdaten gelöscht (Gefahrenzone Stufe 1)', ${ctx.actor})`
  return {
    text:
      'Betriebsdaten gelöscht: Belege, Produkte, Partner, Bestände und Protokolle sind weg, ' +
      'die Nummernkreise starten wieder bei 1.',
  }
}

export async function werkszustand(
  _p: { bestaetigung: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Die Funktion prüft selbst, dass das Konto existiert und Administrator
  // ist — ohne ein bleibendes Konto wäre die Instanz nach dem Reset für
  // niemanden mehr erreichbar.
  await sql`select werkszustand_herstellen(${ctx.userId!}::uuid, ${ctx.actor})`
  return {
    text:
      'Werkszustand hergestellt. Die Ersteinrichtung startet beim nächsten Aufruf neu — ' +
      'alle anderen Konten und die selbst gebauten Prozessversionen sind entfernt.',
  }
}
