// src/server.ts
import './types/fastify-augment'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { config, buildSingleTenantClientConfig } from './config'
import { getDbAdapter } from './adapters'
import { verifyApiKey } from './services/client.service'
import { otpRoutes } from './routes/otp.routes'
import { contactRoutes } from './routes/contact.routes'
import { appointmentRoutes } from './routes/appointment.routes'
import { adminRoutes } from './routes/admin.routes'

// Routes that skip client authentication entirely
const AUTH_SKIP_PREFIXES = ['/health', '/docs', '/admin']

function createServer() {
  return Fastify({
    logger: {
      level: config.server.logLevel,
      ...(config.server.nodeEnv === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
    },
  })
}

async function registerApp(app: ReturnType<typeof createServer>) {
  // ── Security ──────────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false })

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const ip = request.ip
      return request.url?.startsWith('/otp') ? `otp-${ip}` : ip
    },
  })

  // ── Client Auth Hook ──────────────────────────────────────────────────────
  // In single-tenant mode: attaches synthetic clientConfig from env vars.
  // In multi-tenant mode: validates X-Client-ID + X-API-Key, resolves config from DB.
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url ?? ''
    if (AUTH_SKIP_PREFIXES.some((p) => url.startsWith(p))) return

    if (!config.multiTenant) {
      request.clientConfig = buildSingleTenantClientConfig()
      return
    }

    const clientId = request.headers['x-client-id'] as string | undefined
    const apiKey   = request.headers['x-api-key']   as string | undefined

    if (!clientId || !apiKey) {
      return reply.status(401).send({ error: 'Missing X-Client-ID or X-API-Key headers' })
    }

    const db     = getDbAdapter()
    const client = await db.getClientConfig(clientId)

    if (!client || !client.active) {
      return reply.status(401).send({ error: 'Unknown or inactive client' })
    }

    if (!verifyApiKey(apiKey, client.apiKeyHash)) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    request.clientConfig = client
  })

  // ── API Docs (Swagger) ────────────────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Brightlite Middleware API',
        description: `
**Brightlite Unqork AI Middleware** — Infrastructure-agnostic intake and appointment scheduling.

## Authentication
In multi-tenant mode (MULTI_TENANT=true), all client-facing routes require:
- \`X-Client-ID\`: your provisioned client ID
- \`X-API-Key\`: your secret API key

Admin routes require:
- \`X-Admin-Key\`: the ADMIN_API_KEY env var (Brightlite internal only)

## Flows

### Contact / Intake
1. \`POST /otp/send\` — send OTP to email or phone
2. \`POST /otp/verify\` — verify the code
3. \`POST /contact/submit\` — submit the form (requires verified OTP token)

### Appointment Scheduling
1. \`POST /otp/send\` → \`POST /otp/verify\` — verify identity
2. \`GET /appointments/services\` — list available services
3. \`GET /appointments/slots\` — get available slots for a date
4. \`POST /appointments/book\` — confirm booking
        `,
        version: '2.0.0',
        contact: {
          name: 'Brightlite Media Corporation',
          url: 'https://brightlite.cloud',
        },
      },
      components: {
        securitySchemes: {
          clientAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'Client API key (from provisioning). Use with X-Client-ID header.',
          },
          adminKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Admin-Key',
            description: 'Brightlite admin key — internal use only.',
          },
        },
      },
      tags: [
        { name: 'Health',       description: 'Server health check' },
        { name: 'OTP',          description: 'One-time password verification' },
        { name: 'Contact',      description: 'Contact / intake form submission and management' },
        { name: 'Appointments', description: 'Appointment scheduling, slots, and management' },
        { name: 'Admin',        description: 'Client provisioning (Brightlite internal)' },
      ],
    },
  })

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: false,
  })

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(otpRoutes,         { prefix: '' })
  await app.register(contactRoutes,     { prefix: '' })
  await app.register(appointmentRoutes, { prefix: '' })
  await app.register(adminRoutes,       { prefix: '/admin' })

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Server health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status:      { type: 'string' },
            version:     { type: 'string' },
            environment: { type: 'string' },
            multiTenant: { type: 'boolean' },
            aiProvider:  { type: 'string' },
            dbAdapter:   { type: 'string' },
            timestamp:   { type: 'string' },
          },
        },
      },
    },
    handler: async (_request, reply) => {
      return reply.send({
        status:      'ok',
        version:     '2.0.0',
        environment: config.server.nodeEnv,
        multiTenant: config.multiTenant,
        aiProvider:  config.ai.provider,
        dbAdapter:   config.db.adapter,
        timestamp:   new Date().toISOString(),
      })
    },
  })

  // ── Global error handler ──────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    app.log.error(error)
    if (error.name === 'ZodError') {
      return reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) })
    }
    if (error.statusCode === 429) {
      return reply.status(429).send({ error: 'Too many requests. Please slow down.' })
    }
    return reply.status(error.statusCode ?? 500).send({ error: error.message ?? 'Internal server error' })
  })

}

export async function buildApp() {
  const app = createServer()
  await registerApp(app)
  return app
}

export async function startServer() {
  const app = await buildApp()

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: config.server.port, host: config.server.host })
    app.log.info(`🤖 AI provider:  ${config.ai.provider}`)
    app.log.info(`🗄️  DB adapter:   ${config.db.adapter}`)
    app.log.info(`🏢 Mode:         ${config.multiTenant ? 'multi-tenant' : `single-tenant (${config.client.name})`}`)
    return app
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

if (require.main === module) {
  void startServer()
}
