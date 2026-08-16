/**
 * Einstieg für `node --import ./scripts/prozess-loader.mjs`: registriert die
 * Auflösungs-Hooks, mit denen die Prozesstests die App-Module unter blankem
 * Node laden können (siehe prozess-loader-hooks.mjs).
 */
import { register } from 'node:module'

register(new URL('./prozess-loader-hooks.mjs', import.meta.url))
