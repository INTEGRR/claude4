import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { type DatevKonten, datevBuchungsstapel, steuergruppen } from '@/modules/verkauf/datev-export'

/**
 * DATEV-Buchungsstapel der Kundenbelege eines Zeitraums (0115):
 * GET /api/verkauf/datev?von=JJJJ-MM-TT&bis=JJJJ-MM-TT — Download als CSV.
 * Stornierte Rechnungen bleiben drin (ihre Gutschrift ebenso): die
 * Buchhaltung sieht beide Belege.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'finanzen', user.befugnisse)) {
    return NextResponse.json({ error: 'Keine Berechtigung für Finanzen' }, { status: 403 })
  }
  const url = new URL(request.url)
  const von = url.searchParams.get('von') ?? ''
  const bis = url.searchParams.get('bis') ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis)) {
    return NextResponse.json({ error: 'von und bis als JJJJ-MM-TT angeben' }, { status: 400 })
  }

  const [einst] = await sql<{ value: Partial<DatevKonten> | null }[]>`select value from settings where key = 'rechnung'`
  const konten: DatevKonten = {
    kontenrahmen: einst?.value?.kontenrahmen === 'SKR04' ? 'SKR04' : 'SKR03',
    debitorenkonto: einst?.value?.debitorenkonto ?? '10000',
    erloeskonto_19: einst?.value?.erloeskonto_19 ?? '8400',
    erloeskonto_7: einst?.value?.erloeskonto_7 ?? '8300',
    erloeskonto_0: einst?.value?.erloeskonto_0 ?? '8120',
    beraternummer: einst?.value?.beraternummer,
    mandantennummer: einst?.value?.mandantennummer,
  }

  const belege = await sql<
    { nummer: string; art: 'rechnung' | 'gutschrift'; rechnungsdatum: string; kunde: string; kundennummer: string | null; auftrag: string | null; positionen: { steuersatz: number; brutto: number }[] }[]
  >`
    select k.nummer, k.art::text as art, k.rechnungsdatum::text as rechnungsdatum,
           coalesce(k.anschrift ->> 'name', p.name) as kunde, k.kundennummer, so.number as auftrag,
           coalesce((select jsonb_agg(jsonb_build_object('steuersatz', kp.steuersatz, 'brutto', kp.brutto))
                     from kundenrechnung_positionen kp where kp.rechnung_id = k.id), '[]'::jsonb) as positionen
    from kundenrechnungen k
    left join partners p on p.id = k.partner_id
    left join sales_orders so on so.id = k.sales_order_id
    where k.rechnungsdatum between ${von}::date and ${bis}::date
      and not k.probe
    order by k.rechnungsdatum, k.nummer`

  const csv = datevBuchungsstapel(
    belege.map((b) => ({ ...b, gruppen: steuergruppen(b.positionen) })),
    konten,
    { von, bis },
  )
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="EXTF_Kundenrechnungen_${von}_${bis}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
