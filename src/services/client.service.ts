// src/services/client.service.ts
// API key generation and verification for multi-tenant client auth.
// Uses Node's built-in crypto — no extra dependencies.

import { createHash, randomBytes } from 'crypto'

const KEY_PREFIX = 'blt_live_'

/**
 * Generates a new plaintext API key.
 * Format: blt_live_<32 random hex chars>
 * Only ever returned once (at provisioning time). Store the hash, not this.
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(16).toString('hex')}`
}

/**
 * Hashes a plaintext API key with SHA-256.
 * This is what gets stored in the database.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

/**
 * Timing-safe comparison of a plaintext key against a stored hash.
 */
export function verifyApiKey(plaintext: string, storedHash: string): boolean {
  const candidateHash = hashApiKey(plaintext)
  // Both strings are hex-encoded SHA-256 — same length, safe to compare directly
  if (candidateHash.length !== storedHash.length) return false
  let diff = 0
  for (let i = 0; i < candidateHash.length; i++) {
    diff |= candidateHash.charCodeAt(i) ^ storedHash.charCodeAt(i)
  }
  return diff === 0
}
