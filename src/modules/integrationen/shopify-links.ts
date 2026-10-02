/**
 * Links in den Shopify-Admin. `SHOPIFY_SHOP_DOMAIN` (z. B. anvil.myshopify.com)
 * leitet selbst auf admin.shopify.com weiter — so braucht KRNL den
 * Store-Handle nicht zu kennen. Ohne Domain gibt es keinen Link.
 */

/** Numerische ID aus einer GID wie gid://shopify/Order/5551234567890. */
export function shopifyNummer(gid: string | null | undefined): string | null {
  const treffer = gid?.match(/(\d+)$/)
  return treffer ? treffer[1] : null
}

export function shopifyBestellungUrl(
  gid: string | null | undefined,
  domain: string | undefined = process.env.SHOPIFY_SHOP_DOMAIN,
): string | null {
  const nummer = shopifyNummer(gid)
  const host = domain?.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!nummer || !host) return null
  return `https://${host}/admin/orders/${nummer}`
}
