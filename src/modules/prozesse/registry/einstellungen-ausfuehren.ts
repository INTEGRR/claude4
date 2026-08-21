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

export async function prozessEntwerfen(
  p: {
    code: string
    name: string
    beschreibung?: string
    bereich: string
    modell?: string
    schritte: EntwurfSchritt[]
    uebergaenge: { von: string; nach: string; bedingung?: unknown; beschriftung?: string }[]
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
  // hart noch einmal in prozess_version_aktivieren.
  for (const s of p.schritte) {
    if (s.art !== 'prozess' || !s.teilprozess) continue
    const [kind] = await sql<{ code: string }[]>`
      select code from prozesse where code = ${s.teilprozess}`
    if (!kind) {
      throw new Error(
        `Schritt „${s.code}": Teilprozess „${s.teilprozess}" existiert nicht — die Liste steht auf /prozesse.`,
      )
    }
  }
  for (const u of p.uebergaenge) {
    if (!codes.has(u.von) || !codes.has(u.nach)) {
      throw new Error(`Übergang ${u.von} → ${u.nach}: beide Enden müssen Schritt-Codes sein.`)
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

    for (const [i, s] of p.schritte.entries()) {
      await t`
        insert into prozess_schritte (version_id, code, name, art, sequence, aktion,
                                      job_kind, ereignis, teilprozess, teilprozess_link,
                                      zustand, rollen, befugnis, params, optional)
        values (${v.id}, ${s.code}, ${s.name}, ${s.art}, ${i * 10}, ${s.aktion ?? null},
                ${s.job_kind ?? null}, ${s.ereignis ?? null},
                ${s.teilprozess ?? null},
                ${s.teilprozess_link ? JSON.stringify(s.teilprozess_link) : null}::jsonb,
                ${s.zustand ?? null}, ${s.rollen ?? null}, ${s.befugnis ?? null},
                ${JSON.stringify(s.params ?? {})}::jsonb, ${s.optional})`
    }
    for (const [i, u] of p.uebergaenge.entries()) {
      await t`
        insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence,
                                         bedingung, beschriftung)
        values (${v.id}, ${u.von}, ${u.nach}, ${(i + 1) * 10},
                ${u.bedingung == null ? null : JSON.stringify(u.bedingung)}::jsonb,
                ${u.beschriftung ?? null})`
    }
    return nr
  })

  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Prozessentwurf ${p.code} v${version} (${p.schritte.length} Schritte)`}, ${ctx.actor})`
  return {
    text:
      `Entwurf gespeichert: ${p.code} Version ${version} — Diagramm prüfen und dann ` +
      'bewusst aktivieren.',
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
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into feld_definitionen (modell, name, label, typ, pflicht, auswahl)
    values (${p.modell}, ${p.name}, ${p.label}, ${p.typ}, ${p.pflicht},
            ${p.auswahl && p.auswahl.length ? p.auswahl : null})
    on conflict (modell, name) do update
      set label = excluded.label, typ = excluded.typ,
          pflicht = excluded.pflicht, auswahl = excluded.auswahl`
  await sql`select log_event('feld_definition', gen_random_uuid(), 'state',
    ${`Eigenes Feld: ${p.modell}.${p.name} (${p.typ})`}, ${ctx.actor})`
  return { text: `Feld ${p.modell}.${p.name} angelegt.` }
}

export async function feldLoeschen(p: {
  modell: string
  name: string
}): Promise<AktionsErgebnis> {
  await sql`delete from feld_definitionen where modell = ${p.modell} and name = ${p.name}`
  return { text: `Feld ${p.modell}.${p.name} entfernt — erfasste Werte bleiben im zusatz stehen.` }
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
