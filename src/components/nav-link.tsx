'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function NavLink({
  href,
  children,
  count,
}: {
  href: string
  children: React.ReactNode
  count?: number
}) {
  const pathname = usePathname()
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <Link className="nav" href={href} aria-current={active ? 'page' : undefined}>
      <span>{children}</span>
      {count !== undefined && count > 0 && <span className="badge neutral">{count}</span>}
    </Link>
  )
}
