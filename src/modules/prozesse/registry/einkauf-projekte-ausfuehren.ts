import { sql, tx } from '@/db/client'
import {
  type EinstandZeile,
  anfrageBetreff,
  anfrageBlock,
  anfrageBlockEinsetzen,
  angebotSumme,
  staffelFuer,
} from '@/modules/einkauf/einkaufsprojekt'
import type { Sprache } from '@/modules/einkauf/mail-vorlagen'
import { money } from '@/modules/shared/format'
import { varianteAufloesen } from './aufloesen.ts'
import { entwurfAnlegen, entwurfLesen, freigabeEinreihen, freigabePruefen } from './einkauf-mailversand-ausfuehren.ts'
import { werkzeugAusBestellung } from './einkauf-werkzeuge-ausfuehren.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 3 (0097): Einkaufsprojekt, Anfragen, Angebote, Entscheidung, Bestellung. */

type Status = 'bedarf' | 'angefragt' | 'entschieden' | 'bestellt' | 'abgeschlossen' | 'abgebrochen'

interface Projekt {
  id: string
  nummer: string
  titel: string
  art: string
  status: Status
  zieltermin: string | null
  verantwortlich_id: string | null
  gewaehltes_angebot_id: string | null
  muster_pflicht: boolean
}

const STATUS_TEXT: Record<Status, string> = {
  bedarf: 'im Bedarf',
  angefragt: 'angefragt',
  entschieden: 'entschieden',
  bestellt: 'bestellt',
  abgeschlossen: 'abgeschlossen',
  abgebrochen: 'abgebrochen',
}

async function projektLesen(id: string, erlaubt?: Status[], wofuer?: string): Promise<Projekt> {
  const [p] = await sql<Projekt[]>`
    select id, nummer, titel, art, status::text as status, zieltermin::text as zieltermin,
           verantwortlich_id, gewaehltes_angebot_id, muster_pflicht
    from einkaufsprojekte where id = ${id}`
  if (!p) throw new Error('Einkaufsprojekt nicht gefunden.')
  if (erlaubt && !erlaubt.includes(p.status)) {
    throw new Error(`${p.nummer} ist ${STATUS_TEXT[p.status]} — ${wofuer ?? 'das geht jetzt nicht mehr'}.`)
  }
  return p
}

interface PositionEingabe {
  bezeichnung?: string
  produkt?: string
  menge: number
  zielpreis_eur?: number
  gewicht_g?: number
  hs_code?: string
  spezifikation?: string
}

/** Artikel auflösen (vor jedem Schreiben — scheitert einer, entsteht nichts halb). */
async function positionAufloesen(p: PositionEingabe): Promise<PositionEingabe & { variant_id: string | null; bezeichnung: string }> {
  if (!p.produkt) return { ...p, variant_id: null, bezeichnung: p.bezeichnung! }
  const v = await varianteAufloesen(sql, p.produkt)
  return { ...p, variant_id: v.id, bezeichnung: p.bezeichnung || v.name }
}

async function ereignis(projektId: string, text: string, actor: string, art = 'info') {
  await sql`select log_event('einkaufsprojekt', ${projektId}, ${art}, ${text}, ${actor})`
}

// --- Projekt und Positionen ------------------------------------------------

const VOR_BESTELLUNG: Status[] = ['bedarf', 'angefragt', 'entschieden']

export async function projektAnlegen(
  p: {
    titel: string
    art: string
    beschreibung?: string
    verantwortlich_id?: string
    zieltermin?: string
    muster_pflicht?: boolean
    positionen: PositionEingabe[]
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const positionen: Awaited<ReturnType<typeof positionAufloesen>>[] = []
  for (const pos of p.positionen) positionen.push(await positionAufloesen(pos))

  const projekt = await tx(async (t) => {
    const [ep] = await t<{ id: string; nummer: string }[]>`
      insert into einkaufsprojekte (nummer, titel, art, beschreibung, verantwortlich_id, zieltermin, muster_pflicht, erstellt_von)
      values (next_sequence('einkaufsprojekt'), ${p.titel}, ${p.art}, ${p.beschreibung ?? null},
              ${p.verantwortlich_id ?? ctx.userId ?? null}, ${p.zieltermin ?? null}, ${p.muster_pflicht ?? false}, ${ctx.actor})
      returning id, nummer`
    for (const [i, pos] of positionen.entries()) {
      await t`
        insert into einkaufsprojekt_positionen
          (projekt_id, sequence, bezeichnung, variant_id, menge, zielpreis_eur, gewicht_g, hs_code, spezifikation)
        values (${ep.id}, ${(i + 1) * 10}, ${pos.bezeichnung}, ${pos.variant_id}, ${pos.menge}, ${pos.zielpreis_eur ?? null},
                ${pos.gewicht_g ?? null}, ${pos.hs_code ?? null}, ${pos.spezifikation ?? null})`
    }
    await t`select log_event('einkaufsprojekt', ${ep.id}, 'state',
                             ${`Projekt angelegt (${positionen.length} Position(en)${p.muster_pflicht ? ', mit Musterpflicht' : ''})`}, ${ctx.actor})`
    return ep
  })
  return {
    text: `Einkaufsprojekt ${projekt.nummer} angelegt.`,
    recordId: projekt.id,
    link: `/einkauf/projekte/${projekt.id}`,
  }
}

export async function projektAendern(
  p: { titel?: string; art?: string; beschreibung?: string; verantwortlich_id?: string; zieltermin?: string; muster_pflicht?: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!)
  const pflichtWechsel = p.muster_pflicht !== undefined && p.muster_pflicht !== projekt.muster_pflicht
  if (pflichtWechsel && !VOR_BESTELLUNG.includes(projekt.status)) {
    throw new Error(`${projekt.nummer} ist ${STATUS_TEXT[projekt.status]} — die Musterpflicht gilt bis zur Bestellung.`)
  }
  await sql`
    update einkaufsprojekte set
      titel = coalesce(${p.titel ?? null}, titel),
      art = coalesce(${p.art ?? null}, art),
      beschreibung = case when ${p.beschreibung !== undefined} then nullif(${p.beschreibung ?? ''}, '') else beschreibung end,
      verantwortlich_id = case when ${p.verantwortlich_id !== undefined}
                               then nullif(${p.verantwortlich_id ?? ''}, '')::uuid else verantwortlich_id end,
      zieltermin = case when ${p.zieltermin !== undefined} then nullif(${p.zieltermin ?? ''}, '')::date else zieltermin end,
      muster_pflicht = coalesce(${p.muster_pflicht ?? null}, muster_pflicht)
    where id = ${projekt.id}`
  // Die Musterpflicht ist eine Bestellregel — ihr Wechsel gehört in den Verlauf.
  if (pflichtWechsel) {
    await ereignis(projekt.id, p.muster_pflicht ? 'Musterpflicht gesetzt' : 'Musterpflicht aufgehoben', ctx.actor)
  }
  return { text: 'Projekt gespeichert.', recordId: projekt.id }
}

export async function positionSetzen(p: PositionEingabe & { position_id?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, VOR_BESTELLUNG, 'Positionen ändern sich nur bis zur Bestellung')
  const pos = await positionAufloesen(p)
  if (p.position_id) {
    const [r] = await sql<{ id: string }[]>`
      update einkaufsprojekt_positionen set
        bezeichnung = ${pos.bezeichnung},
        variant_id = coalesce(${pos.variant_id}::uuid, variant_id),
        menge = ${pos.menge},
        zielpreis_eur = ${pos.zielpreis_eur ?? null},
        gewicht_g = ${pos.gewicht_g ?? null},
        hs_code = ${pos.hs_code ?? null},
        spezifikation = ${pos.spezifikation ?? null}
      where id = ${p.position_id} and projekt_id = ${projekt.id}
      returning id`
    if (!r) throw new Error('Position gehört nicht zu diesem Projekt.')
    return { text: `Position „${pos.bezeichnung}" gespeichert.`, recordId: projekt.id }
  }
  await sql`
    insert into einkaufsprojekt_positionen
      (projekt_id, sequence, bezeichnung, variant_id, menge, zielpreis_eur, gewicht_g, hs_code, spezifikation)
    values (${projekt.id},
            coalesce((select max(sequence) + 10 from einkaufsprojekt_positionen where projekt_id = ${projekt.id}), 10),
            ${pos.bezeichnung}, ${pos.variant_id}, ${pos.menge}, ${pos.zielpreis_eur ?? null},
            ${pos.gewicht_g ?? null}, ${pos.hs_code ?? null}, ${pos.spezifikation ?? null})`
  return { text: `Position „${pos.bezeichnung}" hinzugefügt.`, recordId: projekt.id }
}

export async function positionEntfernen(p: { position_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, VOR_BESTELLUNG, 'Positionen ändern sich nur bis zur Bestellung')
  const [r] = await sql<{ bezeichnung: string }[]>`
    delete from einkaufsprojekt_positionen where id = ${p.position_id} and projekt_id = ${projekt.id}
    returning bezeichnung`
  if (!r) throw new Error('Position gehört nicht zu diesem Projekt.')
  return { text: `Position „${r.bezeichnung}" entfernt.`, recordId: projekt.id }
}

// --- Anfragen -----------------------------------------------------------------

interface AnfragePosZeile {
  bezeichnung: string
  menge: string
  spezifikation: string | null
  einheit: string | null
}

async function projektPositionen(projektId: string): Promise<AnfragePosZeile[]> {
  return sql<AnfragePosZeile[]>`
    select p.bezeichnung, p.menge::text as menge, p.spezifikation, u.name as einheit
    from einkaufsprojekt_positionen p
    left join product_variants pv on pv.id = p.variant_id
    left join product_templates pt on pt.id = pv.template_id
    left join uoms u on u.id = coalesce(pt.purchase_uom_id, pt.uom_id)
    where p.projekt_id = ${projektId}
    order by p.sequence, p.bezeichnung`
}

/** Sprache des Lieferanten — dieselbe Regel wie beim Mail-Entwurf (0094). */
function lieferantenSprache(l: { sprache: string | null; country_code: string | null }): Sprache {
  return (l.sprache as Sprache | null) ?? (l.country_code !== 'DE' ? 'en' : 'de')
}

export async function anfragenSenden(
  p: { partner_ids: string[]; frist?: string; dokument_ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, ['bedarf', 'angefragt'], 'Anfragen gehen vor der Entscheidung hinaus')
  const positionen = await projektPositionen(projekt.id)
  if (positionen.length === 0) throw new Error('Das Projekt hat noch keine Positionen — erst Bedarf erfassen.')
  if (p.dokument_ids.length) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from dokumente where id = any(${p.dokument_ids}::uuid[])`
    if (n !== new Set(p.dokument_ids).size) throw new Error('Mindestens eine gewählte Datei gibt es nicht mehr.')
  }

  const angelegt: string[] = []
  const uebersprungen: string[] = []
  const ohneMail: string[] = []
  for (const partnerId of [...new Set(p.partner_ids)]) {
    const [l] = await sql<{ name: string; email: string | null; sprache: string | null; country_code: string | null }[]>`
      select name, email, sprache, country_code from partners where id = ${partnerId}`
    if (!l) throw new Error('Lieferant nicht gefunden.')
    const [vorhanden] = await sql<{ status: string; entwurf_status: string | null }[]>`
      select a.status, e.status::text as entwurf_status
      from lieferantenanfragen a left join mail_entwuerfe e on e.id = a.entwurf_id
      where a.projekt_id = ${projekt.id} and a.partner_id = ${partnerId}`
    if (vorhanden && (vorhanden.status === 'angefragt' || vorhanden.status === 'angebot')) {
      uebersprungen.push(`${l.name} (schon angefragt)`)
      continue
    }
    if (vorhanden?.status === 'entwurf' && vorhanden.entwurf_status && vorhanden.entwurf_status !== 'verworfen') {
      uebersprungen.push(`${l.name} (Entwurf liegt schon)`)
      continue
    }

    const sprache = lieferantenSprache(l)
    const zahl = (s: string) => Number(s)
    const entwurf = await entwurfAnlegen(
      {
        partner_id: partnerId,
        vorlage: 'anfrage',
        sprache,
        betreff: anfrageBetreff(sprache, projekt),
        anhang_dokument_ids: p.dokument_ids,
        antwort_erwartet_bis: p.frist,
        bestell_pdf: false,
        einkaufsprojekt_id: projekt.id,
      },
      ctx,
      'mensch',
      {
        textAnpassen: (text, s) =>
          anfrageBlockEinsetzen(
            text,
            anfrageBlock(
              s,
              projekt,
              positionen.map((pos) => ({ ...pos, menge: zahl(pos.menge) })),
            ),
            s,
          ),
      },
    )
    await sql`
      insert into lieferantenanfragen (projekt_id, partner_id, status, entwurf_id, frist)
      values (${projekt.id}, ${partnerId}, 'entwurf', ${entwurf.recordId!}, ${p.frist ?? null})
      on conflict (projekt_id, partner_id) do update
        set status = 'entwurf', entwurf_id = excluded.entwurf_id, frist = excluded.frist`
    angelegt.push(l.name)
    if (!l.email) ohneMail.push(l.name)
  }

  if (angelegt.length) await ereignis(projekt.id, `Anfrage-Entwürfe angelegt: ${angelegt.join(', ')}`, ctx.actor)
  const teile = [
    angelegt.length
      ? `${angelegt.length} Anfrage-Entwurf/-Entwürfe angelegt (${angelegt.join(', ')}) — gegenlesen, dann „Anfragen freigeben".`
      : 'Keine neuen Anfragen.',
  ]
  if (uebersprungen.length) teile.push(`Übersprungen: ${uebersprungen.join(', ')}.`)
  if (ohneMail.length) teile.push(`Ohne Mailadresse: ${ohneMail.join(', ')} — Empfänger im Entwurf eintragen.`)
  return { text: teile.join(' '), recordId: projekt.id }
}

export async function anfragenFreigeben(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, ['bedarf', 'angefragt'], 'Anfragen gehen vor der Entscheidung hinaus')
  const anfragen = await sql<{ partner: string; entwurf_id: string | null }[]>`
    select p.name as partner, a.entwurf_id
    from lieferantenanfragen a join partners p on p.id = a.partner_id
    where a.projekt_id = ${projekt.id} and a.status = 'entwurf'
    order by p.name`

  const offen: Awaited<ReturnType<typeof entwurfLesen>>[] = []
  const fehler: string[] = []
  let unterwegs = 0
  for (const a of anfragen) {
    if (!a.entwurf_id) {
      fehler.push(`${a.partner}: kein Entwurf — Anfrage neu vorbereiten`)
      continue
    }
    const e = await entwurfLesen(a.entwurf_id)
    if (e.status === 'freigegeben' || e.status === 'gesendet') {
      unterwegs++
      continue
    }
    if (e.status === 'verworfen') {
      fehler.push(`${a.partner}: Entwurf verworfen — Anfrage neu vorbereiten oder Lieferanten abwählen`)
      continue
    }
    try {
      await freigabePruefen(e)
      offen.push(e)
    } catch (err) {
      fehler.push(`${a.partner}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (fehler.length) throw new Error(`Nichts gesendet — bitte erst beheben: ${fehler.join(' · ')}`)
  if (offen.length === 0 && unterwegs === 0) {
    throw new Error('Keine offenen Anfrage-Entwürfe — erst Lieferanten wählen und „Anfragen vorbereiten".')
  }

  await tx(async (t) => {
    for (const e of offen) await freigabeEinreihen(t as unknown as typeof sql, e, ctx.actor)
    await t`update einkaufsprojekte set status = 'angefragt' where id = ${projekt.id} and status = 'bedarf'`
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'state',
                             ${`Anfragen freigegeben (${offen.length}) — gehen über das Einkaufspostfach hinaus`}, ${ctx.actor})`
  })
  return {
    text: offen.length
      ? `${offen.length} Anfrage(n) freigegeben — sie gehen innerhalb einer Minute hinaus.`
      : 'Alle Anfragen sind schon unterwegs — Projekt steht auf „angefragt".',
    recordId: projekt.id,
  }
}

// --- Angebote ---------------------------------------------------------------------

interface AngebotFelder {
  waehrung?: string
  incoterm_code?: string
  incoterm_ort?: string
  zahlungsbedingung?: string
  anzahlung_pct?: number
  lieferzeit_tage?: number
  moq?: number
  werkzeugkosten?: number
  musterkosten?: number
  fracht_modus?: string
  fracht_je_stueck_eur?: number
  gueltig_bis?: string
  quell_dokument_id?: string
  quell_nachricht_id?: string
  notiz?: string
  staffeln: { position_id: string; ab_menge: number; preis: number }[]
}

async function stammdatenPruefen(p: AngebotFelder) {
  if (p.waehrung) {
    const [w] = await sql<{ code: string }[]>`select code from currencies where code = ${p.waehrung}`
    if (!w) throw new Error(`Währung ${p.waehrung} ist in KRNL nicht angelegt.`)
  }
  if (p.incoterm_code) {
    const [i] = await sql<{ code: string }[]>`select code from incoterms where code = ${p.incoterm_code}`
    if (!i) throw new Error(`Incoterm ${p.incoterm_code} ist unbekannt.`)
  }
}

async function staffelnPruefen(projektId: string, staffeln: AngebotFelder['staffeln']) {
  const ids = [...new Set(staffeln.map((s) => s.position_id))]
  if (!ids.length) return
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from einkaufsprojekt_positionen where projekt_id = ${projektId} and id = any(${ids}::uuid[])`
  if (n !== ids.length) throw new Error('Mindestens ein Preis gehört zu keiner Position dieses Projekts.')
}

async function staffelnSchreiben(t: typeof sql, angebotId: string, staffeln: AngebotFelder['staffeln']) {
  for (const s of staffeln) {
    await t`
      insert into lieferantenangebot_staffeln (angebot_id, position_id, ab_menge, preis)
      values (${angebotId}, ${s.position_id}, ${s.ab_menge}, ${s.preis})
      on conflict (angebot_id, position_id, ab_menge) do update set preis = excluded.preis`
  }
}

/** Einstand eines Angebots als Satz für Rückmeldungen („Einstand 12.345,67 € · Ziel +4,1 %"). */
async function einstandText(angebotId: string): Promise<string> {
  const zeilen = await sql<EinstandZeile[]>`
    select position_id, menge, einstand_eur, zielpreis_eur, hinweise from einstand_schaetzen(${angebotId})`
  const s = angebotSumme(zeilen)
  if (s.gesamt === null) return 'Einstand noch unvollständig'
  const ziel = s.abweichungPct !== null ? ` · ${s.abweichungPct > 0 ? '+' : ''}${String(s.abweichungPct).replace('.', ',')} % zum Ziel` : ''
  return `Einstand ${money(s.gesamt)}${ziel}`
}

export async function angebotErfassen(p: AngebotFelder & { partner_id: string; waehrung: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, VOR_BESTELLUNG, 'Angebote werden bis zur Bestellung erfasst')
  const [l] = await sql<{ name: string }[]>`select name from partners where id = ${p.partner_id}`
  if (!l) throw new Error('Lieferant nicht gefunden.')
  await stammdatenPruefen(p)
  await staffelnPruefen(projekt.id, p.staffeln)

  const angebot = await tx(async (t) => {
    const [anfrage] = await t<{ id: string }[]>`
      select id from lieferantenanfragen where projekt_id = ${projekt.id} and partner_id = ${p.partner_id}`
    const [a] = await t<{ id: string; version: number }[]>`
      insert into lieferantenangebote (
        projekt_id, partner_id, anfrage_id, version, waehrung, incoterm_code, incoterm_ort, zahlungsbedingung,
        anzahlung_pct, lieferzeit_tage, moq, werkzeugkosten, musterkosten, fracht_modus, fracht_je_stueck_eur,
        gueltig_bis, quell_dokument_id, quell_nachricht_id, notiz, quelle, erfasst_von)
      values (
        ${projekt.id}, ${p.partner_id}, ${anfrage?.id ?? null},
        coalesce((select max(version) + 1 from lieferantenangebote where projekt_id = ${projekt.id} and partner_id = ${p.partner_id}), 1),
        ${p.waehrung}, ${p.incoterm_code ?? null}, ${p.incoterm_ort ?? null}, ${p.zahlungsbedingung ?? null},
        ${p.anzahlung_pct ?? null}, ${p.lieferzeit_tage ?? null}, ${p.moq ?? null}, ${p.werkzeugkosten ?? 0},
        ${p.musterkosten ?? 0}, ${p.fracht_modus ?? null}, ${p.fracht_je_stueck_eur ?? null}, ${p.gueltig_bis ?? null},
        ${p.quell_dokument_id ?? null}, ${p.quell_nachricht_id ?? null}, ${p.notiz ?? null}, 'mensch', ${ctx.actor})
      returning id, version`
    await staffelnSchreiben(t as unknown as typeof sql, a.id, p.staffeln)
    if (anfrage) await t`update lieferantenanfragen set status = 'angebot' where id = ${anfrage.id}`
    if (p.quell_dokument_id) {
      await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
              values (${p.quell_dokument_id}, 'einkaufsprojekt', ${projekt.id}, ${ctx.actor}) on conflict do nothing`
    }
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'info',
                             ${`Angebot von ${l.name} erfasst${a.version > 1 ? ` (Version ${a.version})` : ''}`}, ${ctx.actor})`
    return a
  })
  return {
    text: `Angebot von ${l.name}${angebot.version > 1 ? ` (Version ${angebot.version})` : ''} erfasst — ${await einstandText(angebot.id)}.`,
    recordId: projekt.id,
    daten: { angebot_id: angebot.id },
  }
}

async function angebotLesen(id: string) {
  const [a] = await sql<{ id: string; projekt_id: string; partner: string; verworfen: boolean }[]>`
    select a.id, a.projekt_id, p.name as partner, a.verworfen
    from lieferantenangebote a join partners p on p.id = a.partner_id where a.id = ${id}`
  if (!a) throw new Error('Angebot nicht gefunden.')
  return a
}

export async function angebotAendern(p: AngebotFelder & { angebot_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const a = await angebotLesen(p.angebot_id)
  const projekt = await projektLesen(a.projekt_id, VOR_BESTELLUNG, 'nach der Bestellung bleibt das Angebot, wie es bestellt wurde')
  await stammdatenPruefen(p)
  await staffelnPruefen(projekt.id, p.staffeln)
  await tx(async (t) => {
    await t`
      update lieferantenangebote set
        waehrung = coalesce(${p.waehrung ?? null}, waehrung),
        incoterm_code = coalesce(${p.incoterm_code ?? null}, incoterm_code),
        incoterm_ort = coalesce(${p.incoterm_ort ?? null}, incoterm_ort),
        zahlungsbedingung = coalesce(${p.zahlungsbedingung ?? null}, zahlungsbedingung),
        anzahlung_pct = coalesce(${p.anzahlung_pct ?? null}, anzahlung_pct),
        lieferzeit_tage = coalesce(${p.lieferzeit_tage ?? null}, lieferzeit_tage),
        moq = coalesce(${p.moq ?? null}, moq),
        werkzeugkosten = coalesce(${p.werkzeugkosten ?? null}, werkzeugkosten),
        musterkosten = coalesce(${p.musterkosten ?? null}, musterkosten),
        fracht_modus = coalesce(${p.fracht_modus ?? null}, fracht_modus),
        fracht_je_stueck_eur = coalesce(${p.fracht_je_stueck_eur ?? null}, fracht_je_stueck_eur),
        gueltig_bis = coalesce(${p.gueltig_bis ?? null}::date, gueltig_bis),
        quell_dokument_id = coalesce(${p.quell_dokument_id ?? null}::uuid, quell_dokument_id),
        quell_nachricht_id = coalesce(${p.quell_nachricht_id ?? null}::uuid, quell_nachricht_id),
        notiz = coalesce(${p.notiz ?? null}, notiz)
      where id = ${a.id}`
    const positionen = [...new Set(p.staffeln.map((s) => s.position_id))]
    if (positionen.length) {
      await t`delete from lieferantenangebot_staffeln where angebot_id = ${a.id} and position_id = any(${positionen}::uuid[])`
      await staffelnSchreiben(t as unknown as typeof sql, a.id, p.staffeln)
    }
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'info', ${`Angebot von ${a.partner} geändert`}, ${ctx.actor})`
  })
  return { text: `Angebot von ${a.partner} gespeichert — ${await einstandText(a.id)}.`, recordId: projekt.id }
}

export async function angebotVerwerfen(p: { angebot_id: string; verworfen: boolean }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const a = await angebotLesen(p.angebot_id)
  const projekt = await projektLesen(a.projekt_id, VOR_BESTELLUNG, 'nach der Bestellung bleibt der Vergleich, wie er war')
  if (p.verworfen && projekt.gewaehltes_angebot_id === a.id) {
    throw new Error('Das ist das gewählte Angebot — erst ein anderes wählen.')
  }
  await sql`update lieferantenangebote set verworfen = ${p.verworfen} where id = ${a.id}`
  await ereignis(projekt.id, `Angebot von ${a.partner} ${p.verworfen ? 'verworfen' : 'wieder im Vergleich'}`, ctx.actor)
  return { text: p.verworfen ? `Angebot von ${a.partner} verworfen.` : `Angebot von ${a.partner} wieder im Vergleich.`, recordId: projekt.id }
}

// --- Entscheidung, Bestellung, Abschluss ------------------------------------------------

export async function projektEntscheiden(p: { angebot_id: string; begruendung?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, VOR_BESTELLUNG, 'entschieden wird vor der Bestellung')
  const a = await angebotLesen(p.angebot_id)
  if (a.projekt_id !== projekt.id) throw new Error('Das Angebot gehört zu einem anderen Projekt.')
  if (a.verworfen) throw new Error('Das Angebot ist verworfen — erst zurückholen.')
  const ohnePreis = await sql<{ bezeichnung: string }[]>`
    select pos.bezeichnung from einkaufsprojekt_positionen pos
    where pos.projekt_id = ${projekt.id}
      and not exists (select 1 from lieferantenangebot_staffeln s where s.angebot_id = ${a.id} and s.position_id = pos.id)
    order by pos.sequence`
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from einkaufsprojekt_positionen where projekt_id = ${projekt.id}`
  if (n === 0) throw new Error('Das Projekt hat keine Positionen.')
  if (ohnePreis.length) {
    throw new Error(`Das Angebot von ${a.partner} hat keinen Preis für: ${ohnePreis.map((o) => o.bezeichnung).join(', ')}.`)
  }
  await sql`
    update einkaufsprojekte set status = 'entschieden', gewaehltes_angebot_id = ${a.id},
           entscheidung_begruendung = ${p.begruendung ?? null}, entschieden_von = ${ctx.actor}, entschieden_am = now()
    where id = ${projekt.id}`
  await ereignis(projekt.id, `Entschieden für ${a.partner}${p.begruendung ? `: ${p.begruendung}` : ''}`, ctx.actor, 'state')
  return { text: `Entschieden für ${a.partner} — ${await einstandText(a.id)}.`, recordId: projekt.id }
}

/** Dienstleistungs-Artikel für Werkzeug- und Musterkosten (einmal angelegt, danach wiederverwendet). */
async function kostenArtikel(t: typeof sql): Promise<string> {
  const name = 'Werkzeug- und Musterkosten (Einkauf)'
  const [da] = await t<{ id: string }[]>`
    select pv.id from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pt.name = ${name} and pt.type = 'service' and pv.active
    order by pv.created_at limit 1`
  if (da) return da.id
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, type, uom_id, can_be_sold, can_be_purchased)
    values (${name}, 'service', (select id from uoms where name = 'Stück' limit 1), false, true)
    returning id`
  await t`select generate_variants(${tpl.id})`
  const [v] = await t<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id} limit 1`
  return v.id
}

export async function projektBestellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, ['entschieden'], 'bestellt wird nach der Entscheidung')
  if (!projekt.gewaehltes_angebot_id) throw new Error('Kein Angebot gewählt.')
  const [a] = await sql<
    {
      id: string
      partner_id: string
      partner: string
      waehrung: string
      incoterm_code: string | null
      incoterm_ort: string | null
      anzahlung_pct: string | null
      lieferzeit_tage: number | null
      werkzeugkosten: string
      musterkosten: string
      gueltig_bis: string | null
      zahlungsbedingung: string | null
    }[]
  >`
    select a.id, a.partner_id, p.name as partner, a.waehrung, a.incoterm_code, a.incoterm_ort, a.anzahlung_pct::text,
           a.lieferzeit_tage, a.werkzeugkosten::text, a.musterkosten::text, a.gueltig_bis::text, a.zahlungsbedingung
    from lieferantenangebote a join partners p on p.id = a.partner_id
    where a.id = ${projekt.gewaehltes_angebot_id}`
  if (!a) throw new Error('Das gewählte Angebot gibt es nicht mehr.')

  const positionen = await sql<
    { id: string; bezeichnung: string; variant_id: string | null; menge: string; gewicht_g: string | null; hs_code: string | null }[]
  >`
    select id, bezeichnung, variant_id, menge::text, gewicht_g::text, hs_code
    from einkaufsprojekt_positionen where projekt_id = ${projekt.id} order by sequence, bezeichnung`
  const staffeln = await sql<{ id: string; position_id: string; ab_menge: number; preis: number }[]>`
    select id, position_id, ab_menge::float as ab_menge, preis::float as preis
    from lieferantenangebot_staffeln where angebot_id = ${a.id}`
  for (const pos of positionen) {
    if (!staffeln.some((s) => s.position_id === pos.id)) throw new Error(`Kein Preis für „${pos.bezeichnung}" im gewählten Angebot.`)
  }

  const bestellung = await tx(async (tr) => {
    const t = tr as unknown as typeof sql
    const neueArtikel: string[] = []
    // Artikel für neue Teile — Betriebsausstattung kommt nicht ins Lager (Dienstleistung, kein Wareneingang).
    for (const pos of positionen) {
      if (pos.variant_id) continue
      const [tpl] = await t<{ id: string }[]>`
        insert into product_templates (name, type, uom_id, weight_g, hs_code, can_be_sold, can_be_purchased, route_buy)
        values (${pos.bezeichnung}, ${projekt.art === 'betriebsausstattung' ? 'service' : 'goods'},
                (select id from uoms where name = 'Stück' limit 1), ${Math.round(Number(pos.gewicht_g ?? 0))},
                ${pos.hs_code ?? null}, false, true, true)
        returning id`
      await t`select generate_variants(${tpl.id})`
      const [v] = await t<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id} limit 1`
      await t`update einkaufsprojekt_positionen set variant_id = ${v.id} where id = ${pos.id}`
      pos.variant_id = v.id
      neueArtikel.push(pos.bezeichnung)
    }

    const [po] = await t<{ id: string; number: string }[]>`
      insert into purchase_orders (number, vendor_id, currency, incoterm_code, einkaufsprojekt_id, user_id, note, expected_arrival, origin)
      values (next_sequence('purchase'), ${a.partner_id}, ${a.waehrung}, ${a.incoterm_code},
              ${projekt.id}, ${projekt.verantwortlich_id ?? ctx.userId ?? null},
              ${[`Aus Einkaufsprojekt ${projekt.nummer} – ${projekt.titel}`, a.incoterm_ort && `Incoterm-Ort: ${a.incoterm_ort}`, a.zahlungsbedingung && `Zahlung: ${a.zahlungsbedingung}`].filter(Boolean).join('\n')},
              ${a.lieferzeit_tage !== null ? t`now() + make_interval(days => ${a.lieferzeit_tage})` : null},
              ${projekt.nummer})
      returning id, number`

    let sequence = 10
    const zeile = async (variantId: string, name: string, menge: number, preis: number, staffelId: string | null) => {
      const [neu] = await t<{ id: string }[]>`
        insert into purchase_order_lines
          (order_id, sequence, variant_id, name, qty, uom_id, price_unit, discount, tax_id, tax_rate, angebot_staffel_id)
        select ${po.id}, ${sequence}, ${variantId}, ${name}, ${menge}, coalesce(pt.purchase_uom_id, pt.uom_id), ${preis}, 0,
               pt.purchase_tax_id, coalesce((select amount from taxes where id = pt.purchase_tax_id), 19), ${staffelId}
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${variantId}
        returning id`
      sequence += 10
      return neu.id
    }
    for (const pos of positionen) {
      const s = staffelFuer(staffeln.filter((x) => x.position_id === pos.id), Number(pos.menge))!
      await zeile(pos.variant_id!, pos.bezeichnung, Number(pos.menge), s.preis, s.id)
    }
    const werkzeug = Number(a.werkzeugkosten)
    const muster = Number(a.musterkosten)
    let werkzeugNr: string | null = null
    if (werkzeug > 0 || muster > 0) {
      const kosten = await kostenArtikel(t)
      if (werkzeug > 0) {
        const zeileId = await zeile(kosten, `Werkzeugkosten laut Angebot (${projekt.nummer})`, 1, werkzeug, null)
        // Stufe 4 (0107): das bezahlte Werkzeug wird ein Datensatz am Lieferanten.
        const wz = await werkzeugAusBestellung(t, {
          projektId: projekt.id,
          projektNummer: projekt.nummer,
          projektTitel: projekt.titel,
          partnerId: a.partner_id,
          zeileId,
          bestellnummer: po.number,
          kosten: werkzeug,
          waehrung: a.waehrung,
          actor: ctx.actor,
        })
        werkzeugNr = wz.nummer
      }
      if (muster > 0) await zeile(kosten, `Musterkosten laut Angebot (${projekt.nummer})`, 1, muster, null)
    }

    // Lieferantenpreise aus allen Staffeln — beim nächsten Mal schlägt KRNL sie selbst vor.
    for (const pos of positionen) {
      for (const s of staffeln.filter((x) => x.position_id === pos.id)) {
        await t`delete from vendor_prices where angebot_staffel_id = ${s.id}`
        await t`
          insert into vendor_prices (vendor_id, template_id, variant_id, min_qty, price, currency, lead_time_days, date_end,
                                     product_name, angebot_staffel_id)
          select ${a.partner_id}, pv.template_id, pv.id, ${s.ab_menge}, ${s.preis}, ${a.waehrung}, ${a.lieferzeit_tage ?? 0},
                 ${a.gueltig_bis}, ${pos.bezeichnung}, ${s.id}
          from product_variants pv where pv.id = ${pos.variant_id!}`
      }
    }

    // Zahlplan aus der Anzahlung: Anzahlung bei Bestellung, Rest bei Verschiffung.
    const anzahlung = a.anzahlung_pct !== null ? Number(a.anzahlung_pct) : 0
    if (anzahlung > 0 && anzahlung < 100) {
      await t`insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
              values (${po.id}, 10, ${`Anzahlung ${anzahlung} %`}, ${anzahlung}, 'bestellung')`
      await t`insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
              values (${po.id}, 20, ${`Rest ${100 - anzahlung} %`}, ${100 - anzahlung}, 'verschiffung')`
    } else if (anzahlung >= 100) {
      await t`insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
              values (${po.id}, 10, 'Vorkasse 100 %', 100, 'bestellung')`
    }

    await t`update einkaufsprojekte set status = 'bestellt', bestellt_am = now() where id = ${projekt.id}`
    await t`select log_event('purchase_order', ${po.id}, 'state',
                             ${`Aus Einkaufsprojekt ${projekt.nummer} angelegt (Angebot ${a.partner})`}, ${ctx.actor})`
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'state',
                             ${`Bestellung ${po.number} bei ${a.partner} angelegt${neueArtikel.length ? ` — neue Artikel: ${neueArtikel.join(', ')}` : ''}`},
                             ${ctx.actor})`
    return { ...po, neueArtikel, werkzeugNr }
  })

  return {
    text:
      `Bestellung ${bestellung.number} bei ${a.partner} angelegt (Entwurf)` +
      (bestellung.neueArtikel.length ? ` — neue Artikel: ${bestellung.neueArtikel.join(', ')}` : '') +
      (bestellung.werkzeugNr ? ` — Werkzeug ${bestellung.werkzeugNr}` : '') +
      '. Bestätigen in der Bestellung.',
    recordId: projekt.id,
    link: `/einkauf/${bestellung.id}`,
  }
}

export async function projektAbschliessen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, ['bestellt'], 'abgeschlossen wird ein bestelltes Projekt')
  await sql`update einkaufsprojekte set status = 'abgeschlossen', abgeschlossen_am = now() where id = ${projekt.id}`
  await ereignis(projekt.id, 'Projekt von Hand abgeschlossen', ctx.actor, 'state')
  return { text: `${projekt.nummer} abgeschlossen.`, recordId: projekt.id }
}

export async function projektAbbrechen(p: { grund: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!, ['bedarf', 'angefragt', 'entschieden', 'bestellt'], 'es ist schon beendet')
  if (projekt.status === 'bestellt') {
    const offen = await sql<{ number: string }[]>`
      select number from purchase_orders where einkaufsprojekt_id = ${projekt.id} and state <> 'cancel' order by number`
    if (offen.length) {
      throw new Error(`Erst die Bestellung(en) stornieren: ${offen.map((o) => o.number).join(', ')}.`)
    }
  }
  await tx(async (t) => {
    await t`
      update mail_entwuerfe e set status = 'verworfen'
      from lieferantenanfragen a
      where a.projekt_id = ${projekt.id} and a.entwurf_id = e.id and e.status = 'entwurf'`
    await t`update lieferantenanfragen set status = 'abgesagt' where projekt_id = ${projekt.id} and status = 'entwurf'`
    await t`update einkaufsprojekte set status = 'abgebrochen', abbruch_grund = ${p.grund} where id = ${projekt.id}`
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'state', ${`Abgebrochen: ${p.grund}`}, ${ctx.actor})`
  })
  return { text: `${projekt.nummer} abgebrochen.`, recordId: projekt.id }
}

export async function bestellungProjektZuordnen(
  p: { purchase_order_id: string; loesen: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const projekt = await projektLesen(ctx.recordId!)
  const [po] = await sql<{ number: string; einkaufsprojekt_id: string | null }[]>`
    select number, einkaufsprojekt_id from purchase_orders where id = ${p.purchase_order_id}`
  if (!po) throw new Error('Bestellung nicht gefunden.')
  if (p.loesen) {
    if (po.einkaufsprojekt_id !== projekt.id) throw new Error(`${po.number} hängt nicht an ${projekt.nummer}.`)
    await sql`update purchase_orders set einkaufsprojekt_id = null where id = ${p.purchase_order_id}`
    await ereignis(projekt.id, `Bestellung ${po.number} gelöst`, ctx.actor)
    return { text: `${po.number} vom Projekt gelöst.`, recordId: projekt.id }
  }
  if (po.einkaufsprojekt_id && po.einkaufsprojekt_id !== projekt.id) {
    throw new Error(`${po.number} hängt schon an einem anderen Einkaufsprojekt.`)
  }
  await sql`update purchase_orders set einkaufsprojekt_id = ${projekt.id} where id = ${p.purchase_order_id}`
  await sql`select einkaufsprojekt_pruefen(${projekt.id}, ${ctx.actor})`
  await ereignis(projekt.id, `Bestellung ${po.number} zugeordnet`, ctx.actor)
  return { text: `${po.number} dem Projekt ${projekt.nummer} zugeordnet.`, recordId: projekt.id }
}

// --- Einstand und Kurse ----------------------------------------------------------------

export async function frachtsatzSetzen(
  p: { modus: string; eur_je_kg: number; mindestbetrag_eur: number; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into frachtsaetze (modus, eur_je_kg, mindestbetrag_eur, notiz, geaendert_von)
    values (${p.modus}, ${p.eur_je_kg}, ${p.mindestbetrag_eur}, ${p.notiz ?? null}, ${ctx.actor})
    on conflict (modus) do update
      set eur_je_kg = excluded.eur_je_kg, mindestbetrag_eur = excluded.mindestbetrag_eur,
          notiz = excluded.notiz, geaendert_von = excluded.geaendert_von`
  return { text: `Frachtsatz ${p.modus}: ${String(p.eur_je_kg).replace('.', ',')} €/kg gespeichert.` }
}

export async function zolltarifSetzen(
  p: { hs_praefix: string; satz_pct: number; bezeichnung?: string; loeschen: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  if (p.loeschen) {
    await sql`delete from zolltarife where hs_praefix = ${p.hs_praefix}`
    return { text: `Zollsatz für ${p.hs_praefix} entfernt.` }
  }
  await sql`
    insert into zolltarife (hs_praefix, satz_pct, bezeichnung, geaendert_von)
    values (${p.hs_praefix}, ${p.satz_pct}, ${p.bezeichnung ?? null}, ${ctx.actor})
    on conflict (hs_praefix) do update
      set satz_pct = excluded.satz_pct, bezeichnung = coalesce(excluded.bezeichnung, zolltarife.bezeichnung),
          geaendert_von = excluded.geaendert_von`
  return { text: `Zollsatz ${p.hs_praefix}: ${String(p.satz_pct).replace('.', ',')} % gespeichert.` }
}

export async function ezbKurseHolen(): Promise<AktionsErgebnis> {
  const { ezbKurseAbrufen } = await import('@/modules/einkauf/ezb-abruf')
  return { text: await ezbKurseAbrufen() }
}
