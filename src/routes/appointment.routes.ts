// src/routes/appointment.routes.ts
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { getDbAdapter } from '../adapters'
import { scoreNoShowRisk, parseSchedulingIntent, detectCancellationIntent } from '../services/ai.service'
import { sendEmail } from '../services/email.service'
import { sendSms } from '../services/sms.service'
import { Appointment, SchedulingConfig } from '../types'
import {
  getAvailableSlotsForDate,
  getAvailableSuggestionsForSmartSchedule,
  generateDaysFromNow,
  daysBetween,
  generateConfirmationCode,
} from '../utils/scheduling'

const bookSchema = z.object({
  name:       z.string().min(1),
  email:      z.string().email(),
  phone:      z.string().optional(),
  serviceId:  z.string(),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:       z.string().regex(/^\d{2}:\d{2}$/),
  timezone:   z.string(),
  notes:      z.string().optional(),
  otpTokenId: z.string().uuid(),
})

export async function appointmentRoutes(app: FastifyInstance) {

  // GET /appointments/services
  app.get('/appointments/services', {
    schema: { tags: ['Appointments'], summary: 'List bookable services for this client' },
    handler: async (request, reply) => {
      return reply.send({ services: request.clientConfig.services })
    },
  })

  // GET /appointments/slots
  app.get('/appointments/slots', {
    schema: {
      tags: ['Appointments'],
      summary: 'Get available time slots for a given date and service',
      querystring: {
        type: 'object',
        required: ['date', 'serviceId'],
        properties: {
          date:      { type: 'string' },
          serviceId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { date, serviceId } = request.query as { date: string; serviceId: string }
      const client  = request.clientConfig
      const service = client.services.find((s) => s.id === serviceId)
      if (!service) return reply.status(404).send({ error: 'Service not found' })

      const schedulingConfig: SchedulingConfig = {
        availableDays:      client.availableDays,
        startTime:          client.startTime,
        endTime:            client.endTime,
        slotIntervalMinutes: client.slotIntervalMinutes,
      }

      const slots = await getAvailableSlotsForDate(date, service.durationMinutes, schedulingConfig, client.clientId)
      return reply.send({ date, service, slots })
    },
  })

  // GET /appointments/available-dates
  app.get('/appointments/available-dates', {
    schema: { tags: ['Appointments'], summary: 'Get upcoming available dates for this client' },
    handler: async (request, reply) => {
      const client = request.clientConfig
      const schedulingConfig: SchedulingConfig = {
        availableDays:      client.availableDays,
        startTime:          client.startTime,
        endTime:            client.endTime,
        slotIntervalMinutes: client.slotIntervalMinutes,
      }
      const dates = generateDaysFromNow(30, schedulingConfig)
      return reply.send({ dates })
    },
  })

  // POST /appointments/smart-schedule
  app.post('/appointments/smart-schedule', {
    schema: {
      tags: ['Appointments'],
      summary: 'Parse natural language and suggest matching slots',
      body: {
        type: 'object',
        required: ['naturalLanguageInput', 'serviceId', 'timezone'],
        properties: {
          naturalLanguageInput: { type: 'string' },
          serviceId:            { type: 'string' },
          timezone:             { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { naturalLanguageInput, serviceId, timezone } =
        request.body as { naturalLanguageInput: string; serviceId: string; timezone: string }

      const client  = request.clientConfig
      const service = client.services.find((s) => s.id === serviceId)
      if (!service) return reply.status(404).send({ error: 'Service not found' })

      const schedulingConfig: SchedulingConfig = {
        availableDays:      client.availableDays,
        startTime:          client.startTime,
        endTime:            client.endTime,
        slotIntervalMinutes: client.slotIntervalMinutes,
      }

      const availableSlots = await getAvailableSuggestionsForSmartSchedule(
        14, service.durationMinutes, schedulingConfig, client.clientId
      )

      const result = await parseSchedulingIntent(naturalLanguageInput, availableSlots)
      return reply.send({ ...result, timezone })
    },
  })

  // POST /appointments/book
  app.post('/appointments/book', {
    schema: {
      tags: ['Appointments'],
      summary: 'Book an appointment (requires verified OTP)',
      body: {
        type: 'object',
        required: ['name', 'email', 'serviceId', 'date', 'time', 'timezone', 'otpTokenId'],
        properties: {
          name:       { type: 'string' },
          email:      { type: 'string' },
          phone:      { type: 'string' },
          serviceId:  { type: 'string' },
          date:       { type: 'string' },
          time:       { type: 'string' },
          timezone:   { type: 'string' },
          notes:      { type: 'string' },
          otpTokenId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body   = bookSchema.parse(request.body)
      const db     = getDbAdapter()
      const client = request.clientConfig

      const otpRecord = await db.getOtp(body.otpTokenId)
      if (!otpRecord?.used) {
        return reply.status(400).send({ error: 'OTP must be verified before booking' })
      }

      const service = client.services.find((s) => s.id === body.serviceId)
      if (!service) return reply.status(404).send({ error: 'Service not found' })

      const schedulingConfig: SchedulingConfig = {
        availableDays:      client.availableDays,
        startTime:          client.startTime,
        endTime:            client.endTime,
        slotIntervalMinutes: client.slotIntervalMinutes,
      }

      const slots = await getAvailableSlotsForDate(body.date, service.durationMinutes, schedulingConfig, client.clientId)
      const slot  = slots.find((s) => s.time === body.time)
      if (!slot?.available) {
        return reply.status(409).send({ error: 'This time slot is no longer available' })
      }

      const today      = new Date().toISOString().split('T')[0]
      const daysUntil  = daysBetween(today, body.date)
      const noShowResult = await scoreNoShowRisk({
        serviceLabel:                     service.label,
        date:                             body.date,
        time:                             body.time,
        durationMinutes:                  service.durationMinutes,
        daysBetweenBookingAndAppointment: daysUntil,
        notes:                            body.notes,
      })

      const appointment: Appointment = {
        id:               uuidv4(),
        clientId:         client.clientId,
        name:             body.name,
        email:            body.email,
        phone:            body.phone,
        serviceId:        body.serviceId,
        serviceLabel:     service.label,
        durationMinutes:  service.durationMinutes,
        date:             body.date,
        time:             body.time,
        timezone:         body.timezone,
        notes:            body.notes,
        otpTokenId:       body.otpTokenId,
        status:           'confirmed',
        noShowRiskScore:  noShowResult.riskScore,
        confirmationCode: generateConfirmationCode(),
        createdAt:        new Date(),
        updatedAt:        new Date(),
      }

      await db.saveAppointment(appointment)

      await sendEmail({
        to: body.email,
        subject: `Appointment Confirmed – ${service.label} on ${body.date}`,
        html: `
          <div style="font-family: sans-serif; max-width: 520px;">
            <h2>Your appointment is confirmed!</h2>
            <table style="width:100%; border-collapse: collapse;">
              <tr><td><strong>Service</strong></td><td>${service.label}</td></tr>
              <tr><td><strong>Date</strong></td><td>${body.date}</td></tr>
              <tr><td><strong>Time</strong></td><td>${body.time} (${body.timezone})</td></tr>
              <tr><td><strong>Duration</strong></td><td>${service.durationMinutes} minutes</td></tr>
              <tr><td><strong>Confirmation Code</strong></td><td>${appointment.confirmationCode}</td></tr>
            </table>
            <p style="margin-top:16px; color:#666; font-size:13px;">
              Need to reschedule? Reply to this email with your confirmation code.
            </p>
          </div>
        `,
      })

      if (body.phone) {
        await sendSms({
          to: body.phone,
          body: `${client.name}: Confirmed! ${service.label} on ${body.date} at ${body.time}. Code: ${appointment.confirmationCode}`,
        })
      }

      if (noShowResult.riskLabel === 'high' && body.phone) {
        await sendSms({
          to: body.phone,
          body: `Reminder: Your ${service.label} appointment is on ${body.date} at ${body.time}. We look forward to seeing you!`,
        })
      }

      return reply.send({
        success:          true,
        appointmentId:    appointment.id,
        confirmationCode: appointment.confirmationCode,
        noShowRiskScore:  noShowResult.riskScore,
        message:          'Appointment confirmed! Check your email for details.',
      })
    },
  })

  // GET /appointments
  app.get('/appointments', {
    schema: {
      tags: ['Appointments'],
      summary: 'List appointments for this client',
      querystring: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          status: { type: 'string' },
          q: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDbAdapter()
      const query = request.query as { date?: string; status?: any; q?: string }
      const result = await db.getAppointments({
        clientId: request.clientConfig.clientId,
        date: query.date,
        status: query.status,
        search: query.q,
      })
      return reply.send(result)
    },
  })

  // PATCH /appointments/:id
  app.patch('/appointments/:id', {
    schema: {
      tags: ['Appointments'],
      summary: 'Cancel or update an appointment',
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['cancelled', 'rescheduled', 'completed', 'no_show'] },
          date:   { type: 'string' },
          time:   { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db     = getDbAdapter()

      const appointment = await db.getAppointment(id)
      if (!appointment || appointment.clientId !== request.clientConfig.clientId) {
        return reply.status(404).send({ error: 'Appointment not found' })
      }

      const body = request.body as { status?: any; date?: string; time?: string }
      await db.updateAppointment(id, body)

      if (body.status === 'cancelled') {
        await sendEmail({
          to: appointment.email,
          subject: `Appointment Cancelled – ${appointment.serviceLabel}`,
          html: `
            <div style="font-family: sans-serif;">
              <h2>Appointment Cancelled</h2>
              <p>Your ${appointment.serviceLabel} appointment on ${appointment.date} at ${appointment.time} has been cancelled.</p>
              <p>Please reach out to reschedule at your convenience.</p>
            </div>
          `,
        })
      }

      return reply.send(await db.getAppointment(id))
    },
  })

  // POST /appointments/detect-intent
  app.post('/appointments/detect-intent', {
    schema: {
      tags: ['Appointments'],
      summary: 'Detect cancellation or reschedule intent from a user message',
      body: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const { message } = request.body as { message: string }
      const result = await detectCancellationIntent(message)
      return reply.send(result)
    },
  })
}
