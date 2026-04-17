// src/config/index.ts
import 'dotenv/config'
import { AppointmentService, ClientConfig } from '../types'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function parseServices(): AppointmentService[] {
  const raw = optional(
    'APPOINTMENT_SERVICES',
    '[{"id":"consultation","label":"Consultation","durationMinutes":30},{"id":"demo","label":"Demo","durationMinutes":60}]'
  )
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('APPOINTMENT_SERVICES must be valid JSON')
  }
}

export const config = {
  server: {
    port: parseInt(optional('PORT', '3000')),
    host: optional('HOST', '0.0.0.0'),
    nodeEnv: optional('NODE_ENV', 'development'),
    logLevel: optional('LOG_LEVEL', 'info'),
  },

  multiTenant: optional('MULTI_TENANT', 'false') === 'true',

  adminApiKey: optional('ADMIN_API_KEY', ''),

  ai: {
    provider: optional('AI_PROVIDER', 'anthropic') as 'anthropic' | 'openai',
    anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
    openaiApiKey: optional('OPENAI_API_KEY', ''),
    openaiModel: optional('OPENAI_MODEL', 'gpt-4o'),
  },

  embeddings: {
    provider: optional('EMBEDDING_PROVIDER', process.env.CLAUDE_API_KEY ? 'anthropic' : 'mock') as 'anthropic' | 'mock',
    openaiModel: optional('EMBEDDING_ANTHROPIC_MODEL', 'claude-4-5-sonnet-20260319'),
    dimensions: parseInt(optional('EMBEDDING_DIMENSIONS', '256')),
  },

  otp: {
    expirySeconds: parseInt(optional('OTP_EXPIRY_SECONDS', '300')),
    length: parseInt(optional('OTP_LENGTH', '6')),
  },

  twilio: {
    accountSid: optional('TWILIO_ACCOUNT_SID', ''),
    authToken: optional('TWILIO_AUTH_TOKEN', ''),
    fromNumber: optional('TWILIO_FROM_NUMBER', ''),
  },

  email: {
    provider: optional('EMAIL_PROVIDER', 'sendgrid') as 'sendgrid' | 'smtp',
    sendgridApiKey: optional('SENDGRID_API_KEY', ''),
    from: optional('EMAIL_FROM', 'no-reply@brightlite.cloud'),
    fromName: optional('EMAIL_FROM_NAME', 'Brightlite'),
    smtp: {
      host: optional('SMTP_HOST', ''),
      port: parseInt(optional('SMTP_PORT', '587')),
      user: optional('SMTP_USER', ''),
      pass: optional('SMTP_PASS', ''),
    },
  },

  db: {
    adapter: optional('DB_ADAPTER', 'memory') as 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'memory',
    postgresUrl: optional('POSTGRES_URL', ''),
    mysqlUrl: optional('MYSQL_URL', ''),
    mongoUrl: optional('MONGO_URL', ''),
    mongoDbName: optional('MONGO_DB_NAME', ''),
    mongoReadPreference: optional('MONGO_READ_PREFERENCE', 'secondaryPreferred') as 'primary' | 'secondary' | 'secondaryPreferred',
    mongoSearchIndexes: {
      lots: optional('MONGO_SEARCH_INDEX_LOTS', 'lots_search'),
      lotPlanVector: optional('MONGO_SEARCH_INDEX_LOT_PLAN_VECTOR', 'lot_plan_vector'),
      submissions: optional('MONGO_SEARCH_INDEX_SUBMISSIONS', 'default'),
      appointments: optional('MONGO_SEARCH_INDEX_APPOINTMENTS', 'default'),
      clients: optional('MONGO_SEARCH_INDEX_CLIENTS', 'default'),
    },
    redisUrl: optional('REDIS_URL', ''),
    redisWriteStream: optional('REDIS_WRITE_STREAM', 'mongo:writebehind'),
  },

  lotSearch: {
    mongoUrl: optional('LOT_VECTOR_MONGO_URL', process.env.MONGO_URL ?? process.env.MONGODB_URI ?? ''),
    mongoDbName: optional('LOT_VECTOR_MONGO_DB_NAME', 'homebuilder'),
  },

  // Used only in single-tenant mode (MULTI_TENANT=false).
  // In multi-tenant mode these are ignored — config comes from the client_configs table.
  client: {
    name: optional('CLIENT_NAME', 'Our Company'),
    timezone: optional('CLIENT_TIMEZONE', 'America/Chicago'),
    services: parseServices(),
    availableDays: optional('APPOINTMENT_AVAILABLE_DAYS', '1,2,3,4,5')
      .split(',')
      .map(Number),
    startTime: optional('APPOINTMENT_START_TIME', '09:00'),
    endTime: optional('APPOINTMENT_END_TIME', '17:00'),
    slotIntervalMinutes: parseInt(optional('APPOINTMENT_SLOT_INTERVAL_MINUTES', '30')),
  },

  routing: {
    sales: optional('ROUTING_SALES', 'sales@yourdomain.com'),
    support: optional('ROUTING_SUPPORT', 'support@yourdomain.com'),
    billing: optional('ROUTING_BILLING', 'billing@yourdomain.com'),
    general: optional('ROUTING_GENERAL', 'info@yourdomain.com'),
  },
} as const

export type Config = typeof config

/**
 * Builds a synthetic ClientConfig from env vars for single-tenant mode.
 * This lets route handlers always use request.clientConfig without branching on mode.
 */
export function buildSingleTenantClientConfig(): ClientConfig {
  const now = new Date()
  return {
    clientId: 'single-tenant',
    apiKeyHash: '',
    name: config.client.name,
    timezone: config.client.timezone,
    services: config.client.services as AppointmentService[],
    availableDays: [...config.client.availableDays],
    startTime: config.client.startTime,
    endTime: config.client.endTime,
    slotIntervalMinutes: config.client.slotIntervalMinutes,
    emailFrom: config.email.from,
    emailFromName: config.email.fromName,
    routing: {
      sales:   config.routing.sales,
      support: config.routing.support,
      billing: config.routing.billing,
      general: config.routing.general,
    },
    active: true,
    createdAt: now,
    updatedAt: now,
  }
}
