/**
 * Region der KI-Verarbeitung (Entscheidungslog 2026-10-16): Auflösung der
 * Einstellung, OpenAI-Basis-URL, Bedrock-Inferenzprofile und die
 * Bereitschaftsprüfung je Weg — pur, ohne Datenbank.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BEDROCK_IDS,
  bedrockBereit,
  bedrockModellId,
  bedrockRegion,
  kiKonfiguriert,
  kiPfadBereit,
  kiRegionAufloesen,
  openaiBasis,
} from '../src/modules/ki/region.ts'
import { MODELL_KATALOG } from '../src/modules/ki/modelle.ts'

describe('KI-Region: Einstellung vor Env vor Standard', () => {
  test('ohne Eintrag bleibt es beim bisherigen Weg', () => {
    assert.equal(kiRegionAufloesen(null, {}), 'standard')
    assert.equal(kiRegionAufloesen({}, {}), 'standard')
  })
  test('gespeicherte Region gewinnt, Unsinn fällt auf Env bzw. Standard zurück', () => {
    assert.equal(kiRegionAufloesen({ region: 'eu' }, { KI_REGION: 'standard' }), 'eu')
    assert.equal(kiRegionAufloesen({ region: 'mars' }, { KI_REGION: 'eu' }), 'eu')
    assert.equal(kiRegionAufloesen({ region: 'mars' }, { KI_REGION: 'venus' }), 'standard')
  })
  test('OpenAI-Basis je Region', () => {
    assert.equal(openaiBasis('standard'), 'https://api.openai.com')
    assert.equal(openaiBasis('eu'), 'https://eu.api.openai.com')
  })
})

describe('KI-Region: Bedrock-Profile', () => {
  test('jedes Katalogmodell hat eine Bedrock-ID und bekommt das EU-Präfix', () => {
    for (const m of MODELL_KATALOG) {
      assert.ok(BEDROCK_IDS[m.id], `Bedrock-ID für ${m.id}`)
      assert.equal(bedrockModellId(m.id, {}), `eu.${BEDROCK_IDS[m.id]}`)
    }
    assert.equal(bedrockModellId('claude-sonnet-5-5', {}), 'eu.anthropic.claude-sonnet-5-5')
    assert.equal(bedrockModellId('claude-haiku-4-5-20251001', {}), 'eu.anthropic.claude-haiku-4-5-20251001-v1:0')
  })
  test('Präfix und einzelne Profile sind per Env übersteuerbar, fertige Profile bleiben', () => {
    assert.equal(bedrockModellId('claude-sonnet-5-5', { BEDROCK_PRAEFIX: 'global.' }), 'global.anthropic.claude-sonnet-5-5')
    assert.equal(
      bedrockModellId('claude-haiku-4-5-20251001', { BEDROCK_MODELL_CLAUDE_HAIKU_4_5_20251001: 'eu.anthropic.claude-haiku-4-5-x' }),
      'eu.anthropic.claude-haiku-4-5-x',
    )
    assert.equal(bedrockModellId('eu.anthropic.claude-opus-5', {}), 'eu.anthropic.claude-opus-5')
    assert.equal(bedrockModellId('anthropic.claude-opus-5', {}), 'anthropic.claude-opus-5')
    // Unbekanntes Modell aus einer Env-Variable: bestmöglich abgeleitet, kein Absturz.
    assert.equal(bedrockModellId('claude-neu-9', {}), 'eu.anthropic.claude-neu-9')
  })
  test('Region: BEDROCK_REGION vor AWS_REGION vor Irland', () => {
    assert.equal(bedrockRegion({}), 'eu-west-1')
    assert.equal(bedrockRegion({ AWS_REGION: 'eu-north-1' }), 'eu-north-1')
    assert.equal(bedrockRegion({ AWS_REGION: 'eu-north-1', BEDROCK_REGION: 'eu-central-1' }), 'eu-central-1')
  })
})

describe('KI-Region: Bereitschaft je Weg, kein stiller Rückfall', () => {
  test('Bedrock braucht Bearer-Token oder Schlüsselpaar', () => {
    assert.equal(bedrockBereit({}), false)
    assert.equal(bedrockBereit({ AWS_ACCESS_KEY_ID: 'a' }), false)
    assert.equal(bedrockBereit({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }), true)
    assert.equal(bedrockBereit({ AWS_BEARER_TOKEN_BEDROCK: 't' }), true)
  })
  test('der Weg der Region entscheidet, nicht irgendein Schlüssel', () => {
    assert.equal(kiPfadBereit('standard', { ANTHROPIC_API_KEY: 'k' }), true)
    assert.equal(kiPfadBereit('eu', { ANTHROPIC_API_KEY: 'k' }), false)
    assert.equal(kiPfadBereit('eu', { AWS_BEARER_TOKEN_BEDROCK: 't' }), true)
    assert.equal(kiPfadBereit('standard', { AWS_BEARER_TOKEN_BEDROCK: 't' }), false)
  })
  test('konfiguriert heißt: mindestens ein Weg ist da', () => {
    assert.equal(kiKonfiguriert({}), false)
    assert.equal(kiKonfiguriert({ ANTHROPIC_API_KEY: 'k' }), true)
    assert.equal(kiKonfiguriert({ AWS_BEARER_TOKEN_BEDROCK: 't' }), true)
  })
})
