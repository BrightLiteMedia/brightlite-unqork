// src/routes/otp.routes.ts
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendOtp, verifyOtp } from '../services/otp.service'

const sendSchema = z.object({
  channel:     z.enum(['email', 'sms']),
  destination: z.string().min(3),
})

const verifySchema = z.object({
  tokenId: z.string().uuid(),
  code:    z.string().length(6),
})

export async function otpRoutes(app: FastifyInstance) {
  // POST /otp/send
  app.post('/otp/send', {
    schema: {
      tags: ['OTP'],
      summary: 'Send a one-time verification code via email or SMS',
      body: {
        type: 'object',
        required: ['channel', 'destination'],
        properties: {
          channel:     { type: 'string', enum: ['email', 'sms'] },
          destination: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = sendSchema.parse(request.body)
      const result = await sendOtp({
        channel:     body.channel,
        destination: body.destination,
        clientId:    request.clientConfig.clientId,
        clientName:  request.clientConfig.name,
      })
      return reply.send(result)
    },
  })

  // POST /otp/verify
  app.post('/otp/verify', {
    schema: {
      tags: ['OTP'],
      summary: 'Verify a one-time code',
      body: {
        type: 'object',
        required: ['tokenId', 'code'],
        properties: {
          tokenId: { type: 'string' },
          code:    { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body   = verifySchema.parse(request.body)
      const result = await verifyOtp(body)
      const status = result.valid ? 200 : 400
      return reply.status(status).send(result)
    },
  })
}
