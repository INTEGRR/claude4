/**
 * Der Interpreter: spielt einen Fixture-Lauf gegen die AKTIVE Prozessversion
 * aus der Datenbank durch — Knöpfe drückt hier niemand, jeder Schritt ist ein
 * Aktionsaufruf über den Torwächter (denselben Weg, den Server Actions und
 * /api/aktion nehmen).
 *
 * Nach jedem Schritt wird geprüft:
 *  - der Schritt wurde vom Prozess tatsächlich ANGEBOTEN (prozess_naechste_schritte),
 *  - die Schritt-Rollen lassen den Test-Nutzer zu (das Panel blendet sonst aus),
 *  - der Beleg steht danach am erwarteten Ort (zustand) bzw. unverändert,
 *  - die Ledger-Invariante hält (Bestand = Summe der Bewegungen).
 */
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import { registrierteAktion } from '../../src/modules/prozesse/registry/index.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import type {
  FixtureKontext,
  ProzessFixture,
  ProzessLauf,
} from '../../src/modules/prozesse/fixtures/typen.ts'
import { assertLedgerConsistent } from '../helpers.ts'

interface Schritt {
  code: string
  art: string
  aktion: string | null
  job_kind: string | null
  zustand: string | null
  params: Record<string, unknown> | null
  rollen: string[] | null
  matching_tabelle?: string | null
  teilprozess?: string | null
  teilprozess_link?: Record<string, unknown> | null
}

/** Schritt aus der aktiven Version lesen (für Start-Schritte und zustand). */
async function schrittAusDefinition(
  sql: Sql,
  prozess: string,
  code: string,
): Promise<Schritt | undefined> {
  const [schritt] = await sql<Schritt[]>`
    select s.code, s.art::text as art, s.aktion, s.job_kind, s.zustand, s.params, s.rollen,
           s.matching_tabelle, s.teilprozess, s.teilprozess_link
    from prozess_schritte s
    where s.version_id = prozess_aktive_version(${prozess}) and s.code = ${code}`
  return schritt
}

/**
 * 'matching'-Schritt: eine offene Zeile der Klärtabelle muss existieren
 * (die Fixture hat sie provoziert), wird über die Auflöse-Aktion des
 * Schritts geklärt — danach ist die Liste leer.
 */
async function matchingAusfuehren(
  sql: Sql,
  prozess: string,
  schritt: Schritt,
  parameter: Record<string, unknown>,
  nutzer: NonNullable<ProzessLauf['nutzer']>,
): Promise<void> {
  assert.ok(schritt.matching_tabelle, `${prozess}/${schritt.code}: matching ohne Tabelle`)
  assert.ok(schritt.aktion, `${prozess}/${schritt.code}: matching ohne Auflöse-Aktion`)

  const offene = await sql<{ id: string }[]>`
    select id from ${sql(schritt.matching_tabelle!)}
    where resolved_at is null order by created_at`
  assert.ok(offene.length > 0, `${prozess}/${schritt.code}: kein offener Klärfall provoziert`)

  for (const zeile of offene) {
    await aktionAusfuehrenGeprueft(schritt.aktion!, { parameter, recordId: zeile.id }, nutzer)
  }

  const [{ offen }] = await sql<{ offen: number }[]>`
    select count(*)::int as offen from ${sql(schritt.matching_tabelle!)}
    where resolved_at is null`
  assert.equal(Number(offen), 0, `${prozess}/${schritt.code}: Klärliste muss danach leer sein`)
}

/**
 * 'dienst'-Schritt: die Outbox mit den Fake-Adaptern leerarbeiten und
 * prüfen, dass der Job des Schritts durchgelaufen ist.
 */
async function dienstAusfuehren(sql: Sql, prozess: string, schritt: Schritt): Promise<void> {
  assert.ok(schritt.job_kind, `${prozess}/${schritt.code}: Dienstschritt ohne Job`)
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  let runde: Awaited<ReturnType<typeof runDueJobs>>
  // Gedeckelt: ein Job, der sofort neu eingeplant wird, würde die Schleife
  // sonst ewig drehen lassen — ohne Ausgabe und ohne Fehler.
  let runden = 0
  do {
    runde = await runDueJobs(20)
    runden++
    assert.ok(
      runden < 100,
      `${prozess}/${schritt.code}: Outbox wird nach 100 Runden nicht leer — ` +
        'ein Job plant sich immer wieder neu ein.',
    )
  } while (runde.ran > 0)

  const [job] = await sql<{ status: string; last_error: string | null }[]>`
    select status, last_error from integration_jobs
    where kind = ${schritt.job_kind}
    order by created_at desc limit 1`
  assert.ok(job, `${prozess}/${schritt.code}: kein Job „${schritt.job_kind}" in der Outbox`)
  assert.equal(
    job.status,
    'done',
    `${prozess}/${schritt.code}: Job ${schritt.job_kind} ist ${job.status}${job.last_error ? ` — ${job.last_error}` : ''}`,
  )
}

async function standort(sql: Sql, prozess: string, recordId: string): Promise<string | null> {
  const [zeile] = await sql<{ code: string | null }[]>`
    select prozess_aktueller_schritt(${prozess}, ${recordId}) as code`
  return zeile.code
}

export async function prozessDurchspielen(
  sql: Sql,
  fixture: ProzessFixture,
  lauf: ProzessLauf,
  ctx: FixtureKontext,
): Promise<string> {
  const prozess = fixture.prozess
  assert.ok(prozess, 'Daten-Fixtures ohne Prozess haben keine Läufe')
  const nutzer = lauf.nutzer ?? { name: 'prozesstest', role: 'admin' as const }

  // Beleglose Assistenten (modell null) laufen über eine Instanz.
  const [art] = await sql<{ modell: string | null }[]>`
    select modell from prozesse where code = ${prozess}`
  assert.ok(art, `Prozess ${prozess} existiert nicht`)
  if (art.modell === null) return instanzDurchspielen(sql, prozess, lauf, ctx, nutzer)

  let recordId: string | undefined = lauf.beleg ? await lauf.beleg(ctx, sql) : undefined
  if (recordId) ctx[`${prozess}_beleg_id`] = recordId

  for (const code of lauf.pfad) {
    let schritt: Schritt
    if (!recordId) {
      // Noch kein Beleg: der erste Schritt muss direkt am Startknoten hängen.
      // Ausnahme matching: Klärfälle existieren gerade WEIL der Beleg noch
      // nicht entstehen konnte — die Klärliste hängt nicht am Belegzustand.
      const definiert = await schrittAusDefinition(sql, prozess, code)
      assert.ok(definiert, `${prozess}: Schritt „${code}" existiert nicht in der aktiven Version`)
      if (definiert.art !== 'matching') {
        // Mehrfach-Starts: der Schritt muss an IRGENDEINEM Startknoten hängen.
        const [amStart] = await sql<{ ok: boolean }[]>`
          select exists(
            select 1 from prozess_uebergaenge u
            join prozess_schritte s
              on s.version_id = u.version_id and s.code = u.von_code and s.art = 'start'
            where u.version_id = prozess_aktive_version(${prozess})
              and u.nach_code = ${code}
          ) as ok`
        assert.ok(amStart.ok, `${prozess}: „${code}" hängt an keinem Start`)
      }
      schritt = definiert
    } else {
      const naechste = await sql<Schritt[]>`
        select code, art::text as art, aktion, job_kind, rollen, params, null as zustand
        from prozess_naechste_schritte(${prozess}, ${recordId})`
      const angeboten = naechste.find((n) => n.code === code)
      assert.ok(
        angeboten,
        `${prozess}: „${code}" wird nicht angeboten ` +
          `(möglich: ${naechste.map((n) => n.code).join(', ') || '—'})`,
      )
      // zustand/matching/teilprozess liefert die Funktion nicht mit — ergänzen.
      const definiert = await schrittAusDefinition(sql, prozess, code)
      schritt = {
        ...angeboten,
        zustand: definiert?.zustand ?? null,
        matching_tabelle: definiert?.matching_tabelle ?? null,
        teilprozess: definiert?.teilprozess ?? null,
        teilprozess_link: definiert?.teilprozess_link ?? null,
      }
    }

    // Ereignis: die Fixture speist die Außenwelt ein (z. B. künstlicher
    // Shop-Webhook samt Verarbeitung) und liefert ggf. die Beleg-ID —
    // oder bewusst KEINE, wenn ein Klärfall den Beleg noch verhindert.
    if (schritt.art === 'ereignis') {
      const ausloeser = lauf.ereignisse?.[code]
      assert.ok(ausloeser, `${prozess}/${code}: Ereignisschritt ohne Auslöser in der Fixture`)
      const geliefert = await ausloeser(ctx, sql)
      if (!recordId && geliefert) {
        recordId = geliefert
        ctx[`${prozess}_beleg_id`] = recordId
      }
      await assertLedgerConsistent(sql)
      continue
    }

    // Matching: die Klärliste als Prozessschritt — auflösen über die
    // Auflöse-Aktion; ein Folge-Auslöser (lauf.ereignisse[code]) kann den
    // dann erst entstehenden Beleg liefern (z. B. nach der Heilung).
    if (schritt.art === 'matching') {
      const eingabe = lauf.eingaben?.[code]
      const werte = typeof eingabe === 'function' ? await eingabe(ctx, sql) : (eingabe ?? {})
      await matchingAusfuehren(sql, prozess, schritt, werte, nutzer)

      const folge = lauf.ereignisse?.[code]
      if (folge) {
        const geliefert = await folge(ctx, sql)
        if (!recordId && geliefert) {
          recordId = geliefert
          ctx[`${prozess}_beleg_id`] = recordId
        }
      }
      await assertLedgerConsistent(sql)
      continue
    }

    // Dienst: die Outbox arbeitet (mit Fakes), der Job muss durchlaufen.
    if (schritt.art === 'dienst') {
      await dienstAusfuehren(sql, prozess, schritt)
      await assertLedgerConsistent(sql)
      continue
    }

    // Teilprozess (Call Activity): der Auslöser der Fixture treibt die
    // Kindbelege (z. B. bucht den Wareneingang) — danach müssen ALLE
    // Kindbelege am Ende ihres Prozesses stehen, sonst rückt der
    // Elternprozess nicht weiter.
    if (schritt.art === 'prozess') {
      const ausloeser = lauf.ereignisse?.[code]
      assert.ok(ausloeser, `${prozess}/${code}: Teilprozess-Schritt ohne Auslöser in der Fixture`)
      await ausloeser(ctx, sql)

      const stand: { gesamt: number; fertig: number } = (
        await sql<{ gesamt: number; fertig: number }[]>`
          select gesamt, fertig from teilprozess_stand(
            ${schritt.teilprozess!},
            ${schritt.teilprozess_link ? sql.json(schritt.teilprozess_link as never) : null},
            (select modell from prozesse where code = ${prozess}), ${recordId!})`
      )[0]
      assert.ok(Number(stand.gesamt) > 0,
        `${prozess}/${code}: kein Kindbeleg für Teilprozess „${schritt.teilprozess}"`)
      assert.equal(Number(stand.fertig), Number(stand.gesamt),
        `${prozess}/${code}: Teilprozess „${schritt.teilprozess}" ist nicht fertig (${stand.fertig}/${stand.gesamt})`)
      await assertLedgerConsistent(sql)
      continue
    }

    assert.equal(schritt.art, 'aktion', `${prozess}/${code}: Läufe führen nur Aktionsschritte aus`)
    assert.ok(schritt.aktion, `${prozess}/${code}: Aktionsschritt ohne Aktion`)
    if (schritt.rollen?.length) {
      assert.ok(
        schritt.rollen.includes(nutzer.role),
        `${prozess}/${code}: Rolle ${nutzer.role} ist am Schritt nicht zugelassen (${schritt.rollen.join(', ')})`,
      )
    }

    const eingabe = lauf.eingaben?.[code]
    const werte = typeof eingabe === 'function' ? await eingabe(ctx, sql) : (eingabe ?? {})
    // Die Prozessdefinition legt vor (params), der Lauf ergänzt/übersteuert.
    const parameter = { ...(schritt.params ?? {}), ...werte }

    // Anlage-Schritte, deren Aktion an einem ANDEREN Beleg hängt (z. B.
    // Beschaffung an der Meldebestand-Regel): die Fixture liefert die
    // record_id im Eingabeobjekt — dieselbe Konvention wie /api/aktion.
    let aufrufRecordId: string | undefined = recordId
    if (!recordId && typeof parameter.record_id === 'string') {
      aufrufRecordId = parameter.record_id
      delete parameter.record_id
    }

    // Explizit typisiert: die Schleifen-Flussanalyse um das asserted
    // `recordId` macht die Inferenz hier sonst zirkulär (TS7022).
    const vorher: string | null = recordId ? await standort(sql, prozess, recordId) : null
    const ergebnis = await aktionAusfuehrenGeprueft(
      schritt.aktion,
      { parameter, recordId: aufrufRecordId },
      nutzer,
    )

    if (!recordId) {
      recordId = (ergebnis ?? {}).recordId
      assert.ok(recordId, `${prozess}/${code}: der Anlage-Schritt muss eine recordId liefern`)
      // Für spätere Eingabe-Funktionen (z. B. Wareneingang vor der Rechnung).
      ctx[`${prozess}_beleg_id`] = recordId
    }

    if (schritt.zustand) {
      assert.equal(
        await standort(sql, prozess, recordId),
        code,
        `${prozess}: nach „${code}" müsste der Beleg dort stehen`,
      )
    } else if (vorher !== null) {
      assert.equal(
        await standort(sql, prozess, recordId),
        vorher,
        `${prozess}/${code}: ein Schritt ohne zustand darf den Standort nicht ändern`,
      )
    }

    await assertLedgerConsistent(sql)
  }

  assert.ok(recordId, `${prozess}: der Lauf „${lauf.name}" hat keinen Beleg erzeugt`)

  if (lauf.danachKeineSchritte) {
    const uebrig = await sql<{ code: string }[]>`
      select code from prozess_naechste_schritte(${prozess}, ${recordId})`
    assert.equal(
      uebrig.length,
      0,
      `${prozess}: am Ende von „${lauf.name}" bietet der Prozess noch an: ${uebrig.map((u) => u.code).join(', ')}`,
    )
  }

  await lauf.pruefen?.(sql, ctx, recordId)
  return recordId
}

/**
 * Belegloser Assistent: Instanz starten, Schritte über den Torwächter
 * ausführen und die Instanz weiterschalten — genau der Weg, den auch
 * /api/aktion mit instanz_id nimmt. 'ende'-Schritte im Pfad schließen den
 * Assistenten ab (die Kante dorthin muss existieren, weiter prüft das).
 */
async function instanzDurchspielen(
  sql: Sql,
  prozess: string,
  lauf: ProzessLauf,
  ctx: FixtureKontext,
  nutzer: NonNullable<ProzessLauf['nutzer']>,
): Promise<string> {
  const [{ id: instanzId }] = await sql<{ id: string }[]>`
    select prozess_instanz_starten(${prozess}, ${nutzer.name}) as id`

  // Beleggebundene FOLGESCHRITTE im Assistenten: der jüngste von einem
  // Schritt erzeugte Beleg (z. B. die Inventurzählung) wird die recordId
  // der nächsten beleggebundenen Aktion — derselbe Mechanismus wie in
  // /api/aktion (daten->>'beleg_id').
  let belegId: string | undefined

  for (const code of lauf.pfad) {
    const definiert = await schrittAusDefinition(sql, prozess, code)
    assert.ok(definiert, `${prozess}: Schritt „${code}" existiert nicht in der aktiven Version`)

    if (definiert.art === 'ende') {
      // Führte vom letzten Schritt ohnehin nur noch der Weg zum Ende, hat
      // prozess_instanz_weiter schon auf „fertig" geschaltet — dann ist das
      // explizite Ende im Pfad nur noch die Bestätigung.
      const [zustand] = await sql<{ status: string }[]>`
        select status from prozess_instanzen where id = ${instanzId}`
      if (zustand.status !== 'fertig') {
        await sql`select prozess_instanz_weiter(${instanzId}, ${code}, '{}'::jsonb, ${nutzer.name})`
      }
      continue
    }

    const naechste = await sql<Schritt[]>`
      select code, art::text as art, aktion, job_kind, rollen, params, null as zustand
      from prozess_naechste_schritte(${prozess}, ${instanzId})`
    const angeboten = naechste.find((n) => n.code === code)
    assert.ok(
      angeboten,
      `${prozess}: „${code}" wird nicht angeboten ` +
        `(möglich: ${naechste.map((n) => n.code).join(', ') || '—'})`,
    )
    assert.equal(angeboten.art, 'aktion', `${prozess}/${code}: Läufe führen nur Aktionsschritte aus`)
    assert.ok(angeboten.aktion, `${prozess}/${code}: Aktionsschritt ohne Aktion`)
    if (angeboten.rollen?.length) {
      assert.ok(angeboten.rollen.includes(nutzer.role), `${prozess}/${code}: Rolle nicht zugelassen`)
    }

    const eingabe = lauf.eingaben?.[code]
    const werte = typeof eingabe === 'function' ? await eingabe(ctx, sql) : (eingabe ?? {})
    const parameter = { ...(angeboten.params ?? {}), ...werte }

    // Beleggebundene Aktion mitten im Assistenten: der Beleg des vorigen
    // Schritts ist der Bezug (z. B. Zählung erfassen → Differenz buchen).
    const meta = registrierteAktion(angeboten.aktion)
    if (meta?.bindung === 'beleg') {
      assert.ok(belegId, `${prozess}/${code}: beleggebundener Folgeschritt ohne vorher erzeugten Beleg`)
    }

    const ergebnis = await aktionAusfuehrenGeprueft(
      angeboten.aktion,
      { parameter, recordId: meta?.bindung === 'beleg' ? belegId : undefined },
      nutzer,
    )
    const recordId = (ergebnis ?? {}).recordId ?? null
    if (recordId) belegId = recordId
    await sql`select prozess_instanz_weiter(${instanzId}, ${code},
      ${sql.json({
        [`${code}_record_id`]: recordId,
        ...(recordId ? { beleg_id: recordId } : {}),
      })}, ${nutzer.name})`
    if (recordId) ctx[`${prozess}_${code}_id`] = recordId

    assert.equal(
      await standort(sql, prozess, instanzId),
      code,
      `${prozess}: nach „${code}" müsste die Instanz dort stehen`,
    )
    await assertLedgerConsistent(sql)
  }

  if (lauf.danachKeineSchritte) {
    const [zustand] = await sql<{ status: string }[]>`
      select status from prozess_instanzen where id = ${instanzId}`
    assert.equal(zustand.status, 'fertig', `${prozess}: „${lauf.name}" müsste fertig sein`)
  }

  await lauf.pruefen?.(sql, ctx, instanzId)
  return instanzId
}
