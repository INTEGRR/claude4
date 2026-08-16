import { sql, tx } from '@/db/client'
import { REGISTRY } from './index.ts'
import { JOB_KATALOG } from '../jobs-katalog.ts'
import { EREIGNISSE } from '../ereignisse.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Prozess-Verwaltungsaktionen. */

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
  const [prozess] = await sql<{ name: string }[]>`
    update prozesse set aktiv = ${p.aktiv}
    where code = ${p.prozess_code}
    returning name`
  if (!prozess) throw new Error(`Prozess „${p.prozess_code}" existiert nicht.`)

  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Prozess ${p.prozess_code} ${p.aktiv ? 'aktiviert' : 'abgeschaltet'}`}, ${ctx.actor})`
  return {
    text: `„${prozess.name}" ist jetzt ${p.aktiv ? 'aktiv' : 'abgeschaltet'}.`,
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

  // Pivot = Paketwechsel: exakt die Paket-Prozesse an, der Rest aus.
  // bug_ticket ist Infrastruktur und bleibt in jedem Geschäftsmodell an.
  await sql`
    update prozesse
    set aktiv = (code = any(${paket.prozess_codes}) or code = 'bug_ticket')`

  const aktive = await sql<{ code: string }[]>`
    select code from prozesse where aktiv order by code`
  await sql`select log_event('prozess', gen_random_uuid(), 'state',
    ${`Paket ${p.paket_code} aktiviert: ${aktive.map((a) => a.code).join(', ')}`}, ${ctx.actor})`
  return {
    text: `Paket „${paket.name}" aktiviert — aktive Prozesse: ${aktive
      .map((a) => a.code)
      .join(', ')}.`,
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
  // Struktur früh und verständlich prüfen — die harte Validierung (erreichbar,
  // azyklisch, XOR-Regeln) sitzt in prozess_version_aktivieren und läuft erst,
  // wenn ein Mensch den Entwurf aktiviert.
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
                                      zustand, rollen, params, optional)
        values (${v.id}, ${s.code}, ${s.name}, ${s.art}, ${i * 10}, ${s.aktion ?? null},
                ${s.job_kind ?? null}, ${s.ereignis ?? null},
                ${s.teilprozess ?? null},
                ${s.teilprozess_link ? JSON.stringify(s.teilprozess_link) : null}::jsonb,
                ${s.zustand ?? null}, ${s.rollen ?? null},
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
