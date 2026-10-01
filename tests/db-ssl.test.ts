/**
 * Datenbank-TLS im Code (Entscheidungslog 2026-10-01): entfernt immer
 * verschlüsselt, lokal/Docker ohne — eine ausdrückliche Angabe in URL oder
 * Umgebung gewinnt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { datenbankSsl } from '../src/db/ssl.ts'

test('Supabase (Pooler und direkt) läuft mit TLS', () => {
  delete process.env.PGSSL
  delete process.env.PGSSLMODE
  assert.deepEqual(datenbankSsl('postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'), { ssl: 'require' })
  assert.deepEqual(datenbankSsl('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres'), { ssl: 'require' })
})

test('lokal und im Docker-Netz ohne TLS', () => {
  for (const url of [
    'postgres://erp:erp@127.0.0.1:5433/erp',
    'postgres://postgres@localhost:5433/erp',
    'postgres://erp:erp@db:5432/erp',
    'postgres://erp:erp@[::1]:5432/erp',
  ]) {
    assert.deepEqual(datenbankSsl(url), { ssl: false }, url)
  }
})

test('ausdrückliche Angabe gewinnt: sslmode in der URL oder PGSSLMODE (übersetzt)', () => {
  assert.deepEqual(datenbankSsl('postgres://u:p@db.x.supabase.co:5432/postgres?sslmode=verify-full'), {})
  assert.deepEqual(datenbankSsl('postgres://u:p@127.0.0.1:5433/erp?sslmode=require'), {})
  process.env.PGSSLMODE = 'disable'
  try {
    assert.deepEqual(datenbankSsl('postgres://u:p@db.x.supabase.co:5432/postgres'), { ssl: false })
    process.env.PGSSLMODE = 'verify-full'
    assert.deepEqual(datenbankSsl('postgres://u:p@127.0.0.1:5433/erp'), { ssl: 'verify-full' })
  } finally {
    delete process.env.PGSSLMODE
  }
  assert.deepEqual(datenbankSsl('kein-url'), {})
})
