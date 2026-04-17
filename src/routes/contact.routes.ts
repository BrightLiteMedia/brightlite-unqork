// src/routes/contact.routes.ts
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { getDbAdapter } from '../adapters'
import { classifySubmission } from '../services/ai.service'
import { sendEmail } from '../services/email.service'
import { ContactSubmission } from '../types'

const submitSchema = z.object({
  name:       z.string().min(1),
  email:      z.string().email(),
  phone:      z.string().optional(),
  message:    z.string().min(10),
  otpTokenId: z.string().uuid(),
})

export async function contactRoutes(app: FastifyInstance) {

  // POST /contact/submit
  app.post('/contact/submit', {
    schema: {
      tags: ['Contact'],
      summary: 'Submit a verified contact/intake form',
      body: {
        type: 'object',
        required: ['name', 'email', 'message', 'otpTokenId'],
        properties: {
          name:       { type: 'string' },
          email:      { type: 'string' },
          phone:      { type: 'string' },
          message:    { type: 'string' },
          otpTokenId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body   = submitSchema.parse(request.body)
      const db     = getDbAdapter()
      const client = request.clientConfig

      const otpRecord = await db.getOtp(body.otpTokenId)
      if (!otpRecord) {
        return reply.status(400).send({ error: 'Invalid OTP token' })
      }
      if (!otpRecord.used) {
        return reply.status(400).send({ error: 'OTP must be verified before submitting' })
      }
      if (new Date() > new Date(otpRecord.expiresAt.getTime() + 60_000)) {
        return reply.status(400).send({ error: 'Session expired' })
      }

      const routingMap = {
        sales:     client.routing.sales,
        support:   client.routing.support,
        billing:   client.routing.billing,
        general:   client.routing.general,
        complaint: client.routing.support,
        other:     client.routing.general,
      }

      const aiResult = await classifySubmission(body.name, body.message, routingMap)

      const submission: ContactSubmission = {
        id:            uuidv4(),
        clientId:      client.clientId,
        name:          body.name,
        email:         body.email,
        phone:         body.phone,
        message:       body.message,
        otpTokenId:    body.otpTokenId,
        submittedAt:   new Date(),
        category:      aiResult.category,
        sentiment:     aiResult.sentiment,
        sentimentScore: aiResult.sentimentScore,
        spamScore:     aiResult.spamScore,
        isSpam:        aiResult.isSpam,
        suggestedReply: aiResult.suggestedReply,
        routedTo:      aiResult.routingEmail,
        status:        'new',
      }

      if (!aiResult.isSpam) {
        await db.saveSubmission(submission)

        await sendEmail({
          to: aiResult.routingEmail,
          subject: `[${aiResult.category.toUpperCase()}] New inquiry from ${body.name}`,
          html: `
            <h3>New contact submission</h3>
            <p><strong>From:</strong> ${body.name} (${body.email})</p>
            <p><strong>Category:</strong> ${aiResult.category}</p>
            <p><strong>Sentiment:</strong> ${aiResult.sentiment}</p>
            <p><strong>Message:</strong></p>
            <blockquote>${body.message}</blockquote>
            <hr/>
            <p><strong>Suggested reply:</strong></p>
            <p>${aiResult.suggestedReply}</p>
          `,
        })

        await sendEmail({
          to: body.email,
          subject: `We received your message – ${client.name}`,
          html: `
            <div style="font-family: sans-serif; max-width: 520px;">
              <h2>Thanks, ${body.name}!</h2>
              <p>We've received your message and will get back to you shortly.</p>
              <p>Your reference ID is: <strong>${submission.id.split('-')[0].toUpperCase()}</strong></p>
            </div>
          `,
        })
      }

      return reply.send({
        success:      !aiResult.isSpam,
        submissionId: submission.id,
        category:     aiResult.category,
        sentiment:    aiResult.sentiment,
        isSpam:       aiResult.isSpam,
        message:      aiResult.isSpam
          ? 'Submission flagged and not processed'
          : 'Your message has been received. Check your email for confirmation.',
      })
    },
  })

  // GET /contact/submissions
  app.get('/contact/submissions', {
    schema: {
      tags: ['Contact'],
      summary: 'List contact submissions for this client',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['new', 'in_progress', 'resolved'] },
          category: { type: 'string' },
          q: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDbAdapter()
      const query = request.query as { status?: any; category?: any; q?: string }
      const result = await db.getSubmissions({
        clientId: request.clientConfig.clientId,
        status: query.status,
        category: query.category,
        search: query.q,
      })
      return reply.send(result)
    },
  })

  // GET /contact/submissions/:id
  app.get('/contact/submissions/:id', {
    schema: { tags: ['Contact'], summary: 'Get a single submission by ID' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db     = getDbAdapter()
      const submission = await db.getSubmission(id)
      if (!submission || submission.clientId !== request.clientConfig.clientId) {
        return reply.status(404).send({ error: 'Submission not found' })
      }
      return reply.send(submission)
    },
  })

  // PATCH /contact/submissions/:id
  app.patch('/contact/submissions/:id', {
    schema: {
      tags: ['Contact'],
      summary: 'Update submission status or internal notes',
      body: {
        type: 'object',
        properties: {
          status:        { type: 'string', enum: ['new', 'in_progress', 'resolved'] },
          internalNotes: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db     = getDbAdapter()

      const existing = await db.getSubmission(id)
      if (!existing || existing.clientId !== request.clientConfig.clientId) {
        return reply.status(404).send({ error: 'Submission not found' })
      }

      const body = request.body as { status?: any; internalNotes?: string }
      await db.updateSubmission(id, body)
      return reply.send(await db.getSubmission(id))
    },
  })
}
