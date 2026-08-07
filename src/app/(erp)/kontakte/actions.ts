'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'

export async function updatePartner(partnerId: string, formData: FormData) {
  await requireWrite('kontakte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Bitte einen Namen angeben')

  await sql`
    update partners set
      name = ${name},
      is_company = ${formData.get('is_company') === 'on'},
      is_customer = ${formData.get('is_customer') === 'on'},
      is_vendor = ${formData.get('is_vendor') === 'on'},
      email = ${String(formData.get('email') ?? '').trim() || null},
      phone = ${String(formData.get('phone') ?? '').trim() || null},
      mobile = ${String(formData.get('mobile') ?? '').trim() || null},
      website = ${String(formData.get('website') ?? '').trim() || null},
      street = ${String(formData.get('street') ?? '').trim() || null},
      house_number = ${String(formData.get('house_number') ?? '').trim() || null},
      street2 = ${String(formData.get('street2') ?? '').trim() || null},
      zip = ${String(formData.get('zip') ?? '').trim() || null},
      city = ${String(formData.get('city') ?? '').trim() || null},
      country_code = ${String(formData.get('country_code') ?? 'DE').trim().toUpperCase()},
      vat = ${String(formData.get('vat') ?? '').trim() || null},
      ref = ${String(formData.get('ref') ?? '').trim() || null},
      job_title = ${String(formData.get('job_title') ?? '').trim() || null},
      company_registry = ${String(formData.get('company_registry') ?? '').trim() || null},
      user_id = ${String(formData.get('user_id') ?? '') || null},
      customer_payment_term_id = ${String(formData.get('customer_payment_term_id') ?? '') || null},
      supplier_payment_term_id = ${String(formData.get('supplier_payment_term_id') ?? '') || null}
    where id = ${partnerId}`

  revalidatePath(`/kontakte/${partnerId}`)
  revalidatePath('/kontakte')
}

/** Legt einen Unterkontakt an: Ansprechpartner oder abweichende Adresse. */
export async function createChildContact(parentId: string, formData: FormData) {
  await requireWrite('kontakte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Bitte einen Namen angeben')

  await sql`
    insert into partners (
      name, parent_id, partner_type, is_company, email, phone,
      street, house_number, zip, city, country_code)
    select
      ${name}, ${parentId}, ${String(formData.get('partner_type') ?? 'contact')}, false,
      ${String(formData.get('email') ?? '').trim() || null},
      ${String(formData.get('phone') ?? '').trim() || null},
      -- Adresse vom Hauptkontakt übernehmen, wenn nichts angegeben ist
      coalesce(${String(formData.get('street') ?? '').trim() || null}, p.street),
      coalesce(${String(formData.get('house_number') ?? '').trim() || null}, p.house_number),
      coalesce(${String(formData.get('zip') ?? '').trim() || null}, p.zip),
      coalesce(${String(formData.get('city') ?? '').trim() || null}, p.city),
      p.country_code
    from partners p where p.id = ${parentId}`

  revalidatePath(`/kontakte/${parentId}`)
}
