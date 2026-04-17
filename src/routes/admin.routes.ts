// src/routes/admin.routes.ts
// Internal provisioning API — Brightlite uses these to onboard clients.
// Every request must carry X-Admin-Key matching the ADMIN_API_KEY env var.
// Never expose these routes publicly; put them behind a VPN or firewall rule.

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { getDbAdapter } from '../adapters'
import { config } from '../config'
import { generateApiKey, hashApiKey } from '../services/client.service'
import { ClientConfig } from '../types'

const routingSchema = z.object({
  sales:   z.string().email(),
  support: z.string().email(),
  billing: z.string().email(),
  general: z.string().email(),
})

const serviceSchema = z.object({
  id:              z.string().min(1),
  label:           z.string().min(1),
  durationMinutes: z.number().int().positive(),
})

const clientCreateSchema = z.object({
  name:                 z.string().min(1),
  timezone:             z.string().default('America/Chicago'),
  services:             z.array(serviceSchema).min(1),
  availableDays:        z.array(z.number().int().min(0).max(6)).default([1,2,3,4,5]),
  startTime:            z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  endTime:              z.string().regex(/^\d{2}:\d{2}$/).default('17:00'),
  slotIntervalMinutes:  z.number().int().positive().default(30),
  emailFrom:            z.string().email(),
  emailFromName:        z.string().min(1),
  routing:              routingSchema,
})

const clientUpdateSchema = clientCreateSchema.partial().extend({
  active:    z.boolean().optional(),
  rotateKey: z.boolean().optional(),  // set true to issue a new API key
})

function adminGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    const key = request.headers['x-admin-key']
    if (!config.adminApiKey || key !== config.adminApiKey) {
      return reply.status(401).send({ error: 'Invalid or missing X-Admin-Key' })
    }
  })
}

export async function adminRoutes(app: FastifyInstance) {
  adminGuard(app)

  // POST /admin/clients — provision a new client
  // Returns the plaintext API key once — it is never retrievable again.
  app.post('/clients', {
    schema: {
      tags: ['Admin'],
      summary: 'Provision a new client (returns API key once)',
      security: [{ adminKey: [] }],
    },
    handler: async (request, reply) => {
      const body = clientCreateSchema.parse(request.body)
      const db   = getDbAdapter()

      const plainApiKey = generateApiKey()
      const now         = new Date()

      const clientConfig: ClientConfig = {
        clientId:           uuidv4(),
        apiKeyHash:         hashApiKey(plainApiKey),
        name:               body.name,
        timezone:           body.timezone,
        services:           body.services,
        availableDays:      body.availableDays,
        startTime:          body.startTime,
        endTime:            body.endTime,
        slotIntervalMinutes: body.slotIntervalMinutes,
        emailFrom:          body.emailFrom,
        emailFromName:      body.emailFromName,
        routing:            body.routing,
        active:             true,
        createdAt:          now,
        updatedAt:          now,
      }

      await db.saveClientConfig(clientConfig)

      return reply.status(201).send({
        clientId: clientConfig.clientId,
        apiKey:   plainApiKey,          // only time this is ever returned
        name:     clientConfig.name,
        active:   clientConfig.active,
        _note:    'Save the apiKey now — it cannot be retrieved again. Use PATCH /admin/clients/:id with rotateKey:true to issue a new one.',
      })
    },
  })

  // GET /admin/clients — list all provisioned clients (no secrets)
  app.get('/clients', {
    schema: {
      tags: ['Admin'],
      summary: 'List all provisioned clients',
      security: [{ adminKey: [] }],
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDbAdapter()
      const query = request.query as { q?: string }
      return reply.send(await db.listClientConfigs({ search: query.q }))
    },
  })

  // GET /admin/clients/:id — get a single client's config (no secrets)
  app.get('/clients/:id', {
    schema: {
      tags: ['Admin'],
      summary: 'Get a client config by ID',
      security: [{ adminKey: [] }],
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db     = getDbAdapter()
      const client = await db.getClientConfig(id)
      if (!client) return reply.status(404).send({ error: 'Client not found' })
      const { apiKeyHash: _omit, ...safe } = client
      return reply.send(safe)
    },
  })

  // PATCH /admin/clients/:id — update config or rotate the API key
  app.patch('/clients/:id', {
    schema: {
      tags: ['Admin'],
      summary: 'Update client config. Set rotateKey:true to issue a new API key.',
      security: [{ adminKey: [] }],
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db     = getDbAdapter()

      const existing = await db.getClientConfig(id)
      if (!existing) return reply.status(404).send({ error: 'Client not found' })

      const body    = clientUpdateSchema.parse(request.body)
      const updates: Partial<ClientConfig> = { ...body }
      delete (updates as Record<string, unknown>).rotateKey

      let newApiKey: string | undefined
      if (body.rotateKey) {
        newApiKey          = generateApiKey()
        updates.apiKeyHash = hashApiKey(newApiKey)
      }

      await db.updateClientConfig(id, updates)

      const response: Record<string, unknown> = { success: true, clientId: id }
      if (newApiKey) {
        response.apiKey = newApiKey
        response._note  = 'New API key issued. Save it now — it cannot be retrieved again.'
      }
      return reply.send(response)
    },
  })
}
