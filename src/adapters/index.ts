// src/adapters/index.ts
// Factory that returns the correct DB adapter based on config.
// To add a new adapter: implement DbAdapter, add a case here.

import { DbAdapter } from '../types'
import { config } from '../config'
import { MemoryAdapter } from './memory.adapter'
import { MongoDbAdapter } from './mongodb.adapter'
import { PostgresAdapter } from './postgres.adapter'
import { RedisWriteBehindAdapter } from './redis-write-behind.adapter'

let _adapter: DbAdapter | null = null

type ClosableAdapter = DbAdapter & { close?: () => Promise<void> }

export function getDbAdapter(): DbAdapter {
  if (_adapter) return _adapter

  switch (config.db.adapter) {
    case 'memory':
      _adapter = new MemoryAdapter()
      break

    // Stub cases — implement these adapters as needed for production clients
    case 'postgres':
      _adapter = new PostgresAdapter()
      break
    case 'mysql':
      throw new Error(
        'MySQL adapter not yet implemented. Set DB_ADAPTER=memory for dev.'
      )
    case 'mongodb':
      _adapter = config.db.redisUrl
        ? new RedisWriteBehindAdapter(new MongoDbAdapter())
        : new MongoDbAdapter()
      break
    default:
      throw new Error(`Unknown DB_ADAPTER: ${config.db.adapter}`)
  }

  return _adapter
}

export async function closeDbAdapter(): Promise<void> {
  if (!_adapter) return
  const adapter = _adapter as ClosableAdapter
  _adapter = null
  if (typeof adapter.close === 'function') {
    await adapter.close()
  }
}
