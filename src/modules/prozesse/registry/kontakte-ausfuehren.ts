import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Kontakt-Aktionen — Fachlogik unverändert aus kontakte/actions.ts. */

export async function partnerAendern(
  p: {
    name: string
    is_company: boolean
    is_customer: boolean
    is_vendor: boolean
    email?: string
    phone?: string
    mobile?: string
    website?: string
    street?: string
    house_number?: string
    street2?: string
    zip?: string
    city?: string
    country_code: string
    vat?: string
    ref?: string
    job_title?: string
    company_registry?: string
    user_id?: string
    customer_payment_term_id?: string
    supplier_payment_term_id?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update partners set
      name = ${p.name},
      is_company = ${p.is_company},
      is_customer = ${p.is_customer},
      is_vendor = ${p.is_vendor},
      email = ${p.email ?? null},
      phone = ${p.phone ?? null},
      mobile = ${p.mobile ?? null},
      website = ${p.website ?? null},
      street = ${p.street ?? null},
      house_number = ${p.house_number ?? null},
      street2 = ${p.street2 ?? null},
      zip = ${p.zip ?? null},
      city = ${p.city ?? null},
      country_code = ${p.country_code},
      vat = ${p.vat ?? null},
      ref = ${p.ref ?? null},
      job_title = ${p.job_title ?? null},
      company_registry = ${p.company_registry ?? null},
      user_id = ${p.user_id ?? null},
      customer_payment_term_id = ${p.customer_payment_term_id ?? null},
      supplier_payment_term_id = ${p.supplier_payment_term_id ?? null}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function unterkontaktAnlegen(
  p: {
    name: string
    partner_type: string
    email?: string
    phone?: string
    street?: string
    house_number?: string
    zip?: string
    city?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into partners (
      name, parent_id, partner_type, is_company, email, phone,
      street, house_number, zip, city, country_code)
    select
      ${p.name}, ${ctx.recordId!}, ${p.partner_type}, false,
      ${p.email ?? null}, ${p.phone ?? null},
      -- Adresse vom Hauptkontakt übernehmen, wenn nichts angegeben ist
      coalesce(${p.street ?? null}, pa.street),
      coalesce(${p.house_number ?? null}, pa.house_number),
      coalesce(${p.zip ?? null}, pa.zip),
      coalesce(${p.city ?? null}, pa.city),
      pa.country_code
    from partners pa where pa.id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}
