import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

type DbMode = 'memory' | 'mongodb' | 'configured'

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function getDbMode(): DbMode {
  const raw = getArgValue('--db') ?? 'memory'
  if (raw === 'memory' || raw === 'mongodb' || raw === 'configured') return raw
  throw new Error(`Unsupported --db value "${raw}". Use memory, mongodb, or configured.`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function expectStatus(
  response: LightMyRequestResponse,
  expected: number | number[],
  label: string
) {
  const expectedList = Array.isArray(expected) ? expected : [expected]
  assert(
    expectedList.includes(response.statusCode),
    `${label}: expected ${expectedList.join(' or ')}, got ${response.statusCode} with body ${response.body}`
  )
}

function parseJson<T>(response: LightMyRequestResponse, label: string): T {
  try {
    return JSON.parse(response.body) as T
  } catch {
    throw new Error(`${label}: expected JSON response, got ${response.body}`)
  }
}

async function requestJson<T>(
  app: FastifyInstance,
  options: InjectOptions,
  expectedStatus: number | number[],
  label: string
): Promise<T> {
  const response = await app.inject(options)
  expectStatus(response, expectedStatus, label)
  return parseJson<T>(response, label)
}

async function step<T>(label: string, action: () => Promise<T>): Promise<T> {
  const result = await action()
  console.log(`[PASS] ${label}`)
  return result
}

async function sendAndVerifyOtp(
  app: FastifyInstance,
  destination: string
) {
  const sendResult = await requestJson<{ tokenId: string; debugCode?: string }>(
    app,
    {
      method: 'POST',
      url: '/otp/send',
      payload: { channel: 'email', destination },
    },
    200,
    'POST /otp/send'
  )

  assert(sendResult.debugCode, 'POST /otp/send should include debugCode in route test mode')

  const verifyResult = await requestJson<{ valid: boolean; message: string }>(
    app,
    {
      method: 'POST',
      url: '/otp/verify',
      payload: { tokenId: sendResult.tokenId, code: sendResult.debugCode },
    },
    200,
    'POST /otp/verify'
  )

  assert(verifyResult.valid, 'OTP verification should succeed')

  return { tokenId: sendResult.tokenId }
}

async function main() {
  const dbMode = getDbMode()
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const contactEmail = `route-test-contact-${runId}@example.com`
  const bookingEmail = `route-test-booking-${runId}@example.com`
  const tenantName = `Route Test Tenant ${runId}`

  process.env.NODE_ENV = 'development'
  if (dbMode === 'memory') {
    process.env.DB_ADAPTER = 'memory'
  } else if (dbMode === 'mongodb') {
    process.env.DB_ADAPTER = 'mongodb'
    // Route tests should write directly to Mongo instead of depending on the async Redis worker.
    process.env.REDIS_URL = ''
  }
  process.env.MULTI_TENANT = 'false'
  process.env.ADMIN_API_KEY = 'test-admin-key'
  process.env.LOG_LEVEL = 'error'
  process.env.ROUTE_TEST_MODE = 'true'
  process.env.CLIENT_NAME = `Route Test Clinic ${runId}`
  process.env.CLIENT_TIMEZONE = 'America/Chicago'
  process.env.SENDGRID_API_KEY = ''
  process.env.SMTP_HOST = ''
  process.env.SMTP_USER = ''
  process.env.SMTP_PASS = ''
  process.env.TWILIO_ACCOUNT_SID = ''
  process.env.TWILIO_AUTH_TOKEN = ''
  process.env.TWILIO_FROM_NUMBER = ''
  process.env.ANTHROPIC_API_KEY = ''
  process.env.OPENAI_API_KEY = ''
  process.env.APPOINTMENT_SERVICES = JSON.stringify([
    { id: 'consult', label: 'Consultation', durationMinutes: 30 },
    { id: 'follow-up', label: 'Follow-up', durationMinutes: 60 },
  ])

  const { closeDbAdapter } = await import('../adapters')
  const { buildApp } = await import('../server')

  const app = await buildApp()
  await app.ready()

  try {
    console.log(`Running route tests with db mode: ${dbMode}`)

    await step('GET /health', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' })
      expectStatus(response, 200, 'GET /health')
      const body = parseJson<{ status: string }>(response, 'GET /health')
      assert(body.status === 'ok', 'Health response should include status=ok')
    })

    await step('GET /docs', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs' })
      expectStatus(response, [200, 302], 'GET /docs')
    })

    const contactOtp = await step('OTP flow for contact routes', async () =>
      sendAndVerifyOtp(app, contactEmail)
    )

    const contactSubmission = await step('POST /contact/submit', async () =>
      requestJson<{
        success: boolean
        submissionId: string
        category: string
      }>(
        app,
        {
          method: 'POST',
          url: '/contact/submit',
          payload: {
            name: 'Casey Contact',
            email: contactEmail,
            phone: '5551001000',
            message: `I need help choosing the right service for my team. Run ${runId}.`,
            otpTokenId: contactOtp.tokenId,
          },
        },
        200,
        'POST /contact/submit'
      )
    )
    assert(contactSubmission.success, 'Contact submission should succeed')
    assert(contactSubmission.submissionId, 'Contact submission should return a submissionId')

    await step('GET /contact/submissions', async () => {
      const body = await requestJson<{ data: Array<{ id: string }>; total: number }>(
        app,
        { method: 'GET', url: '/contact/submissions' },
        200,
        'GET /contact/submissions'
      )
      assert(body.total >= 1, 'Contact list should contain the created submission')
      assert(
        body.data.some((submission) => submission.id === contactSubmission.submissionId),
        'Contact list should include the created submission'
      )
    })

    await step('GET /contact/submissions/:id', async () => {
      const body = await requestJson<{ id: string }>(
        app,
        { method: 'GET', url: `/contact/submissions/${contactSubmission.submissionId}` },
        200,
        'GET /contact/submissions/:id'
      )
      assert(body.id === contactSubmission.submissionId, 'Fetched submission should match created id')
    })

    await step('PATCH /contact/submissions/:id', async () => {
      const body = await requestJson<{ status: string; internalNotes?: string }>(
        app,
        {
          method: 'PATCH',
          url: `/contact/submissions/${contactSubmission.submissionId}`,
          payload: { status: 'resolved', internalNotes: 'Route smoke test updated this record.' },
        },
        200,
        'PATCH /contact/submissions/:id'
      )
      assert(body.status === 'resolved', 'Submission status should update to resolved')
      assert(body.internalNotes, 'Submission should persist internal notes')
    })

    const appointmentOtp = await step('OTP flow for appointment routes', async () =>
      sendAndVerifyOtp(app, bookingEmail)
    )

    const services = await step('GET /appointments/services', async () =>
      requestJson<{ services: Array<{ id: string }> }>(
        app,
        { method: 'GET', url: '/appointments/services' },
        200,
        'GET /appointments/services'
      )
    )
    assert(services.services.length > 0, 'Appointments services should not be empty')

    const availableDates = await step('GET /appointments/available-dates', async () =>
      requestJson<{ dates: string[] }>(
        app,
        { method: 'GET', url: '/appointments/available-dates' },
        200,
        'GET /appointments/available-dates'
      )
    )
    assert(availableDates.dates.length > 0, 'Available dates should not be empty')

    const serviceId = services.services[0].id
    const bookingDate = availableDates.dates[0]

    const slots = await step('GET /appointments/slots', async () =>
      requestJson<{
        slots: Array<{ time: string; available: boolean }>
      }>(
        app,
        {
          method: 'GET',
          url: `/appointments/slots?date=${encodeURIComponent(bookingDate)}&serviceId=${encodeURIComponent(serviceId)}`,
        },
        200,
        'GET /appointments/slots'
      )
    )
    const firstOpenSlot = slots.slots.find((slot) => slot.available)
    assert(firstOpenSlot, 'At least one appointment slot should be available')

    await step('POST /appointments/smart-schedule', async () => {
      const body = await requestJson<{ parsedIntent: string; suggestions: unknown[] }>(
        app,
        {
          method: 'POST',
          url: '/appointments/smart-schedule',
          payload: {
            naturalLanguageInput: 'Any opening next week in the morning',
            serviceId,
            timezone: 'America/Chicago',
          },
        },
        200,
        'POST /appointments/smart-schedule'
      )
      assert(typeof body.parsedIntent === 'string', 'Smart schedule should return parsedIntent')
      assert(Array.isArray(body.suggestions), 'Smart schedule should return suggestions array')
    })

    const booking = await step('POST /appointments/book', async () =>
      requestJson<{
        success: boolean
        appointmentId: string
        confirmationCode: string
      }>(
        app,
        {
          method: 'POST',
          url: '/appointments/book',
          payload: {
            name: 'Avery Appointment',
            email: bookingEmail,
            phone: '5552002000',
            serviceId,
            date: bookingDate,
            time: firstOpenSlot.time,
            timezone: 'America/Chicago',
            notes: `Please send a reminder the day before. Run ${runId}.`,
            otpTokenId: appointmentOtp.tokenId,
          },
        },
        200,
        'POST /appointments/book'
      )
    )
    assert(booking.success, 'Appointment booking should succeed')
    assert(booking.appointmentId, 'Appointment booking should return an appointmentId')

    await step('GET /appointments', async () => {
      const body = await requestJson<{ data: Array<{ id: string }>; total: number }>(
        app,
        { method: 'GET', url: '/appointments' },
        200,
        'GET /appointments'
      )
      assert(body.total >= 1, 'Appointments list should contain the booked appointment')
      assert(
        body.data.some((appointment) => appointment.id === booking.appointmentId),
        'Appointments list should include the booked appointment'
      )
    })

    await step('PATCH /appointments/:id', async () => {
      const body = await requestJson<{ status: string }>(
        app,
        {
          method: 'PATCH',
          url: `/appointments/${booking.appointmentId}`,
          payload: { status: 'cancelled' },
        },
        200,
        'PATCH /appointments/:id'
      )
      assert(body.status === 'cancelled', 'Appointment status should update to cancelled')
    })

    await step('POST /appointments/detect-intent', async () => {
      const body = await requestJson<{
        wantsCancellation: boolean
        wantsReschedule: boolean
      }>(
        app,
        {
          method: 'POST',
          url: '/appointments/detect-intent',
          payload: { message: 'I need to move my visit to another day.' },
        },
        200,
        'POST /appointments/detect-intent'
      )
      assert(
        typeof body.wantsCancellation === 'boolean' &&
          typeof body.wantsReschedule === 'boolean',
        'Intent detection should return boolean flags'
      )
    })

    const adminHeaders = { 'x-admin-key': process.env.ADMIN_API_KEY as string }

    const createdClient = await step('POST /admin/clients', async () =>
      requestJson<{ clientId: string; apiKey: string; active: boolean }>(
        app,
        {
          method: 'POST',
          url: '/admin/clients',
          headers: adminHeaders,
          payload: {
            name: tenantName,
            timezone: 'America/Chicago',
            services: [{ id: 'intake', label: 'Intake Call', durationMinutes: 45 }],
            availableDays: [1, 2, 3, 4, 5],
            startTime: '09:00',
            endTime: '17:00',
            slotIntervalMinutes: 30,
            emailFrom: 'clinic@example.com',
            emailFromName: 'Test Tenant',
            routing: {
              sales: 'sales@example.com',
              support: 'support@example.com',
              billing: 'billing@example.com',
              general: 'general@example.com',
            },
          },
        },
        201,
        'POST /admin/clients'
      )
    )
    assert(createdClient.clientId, 'Admin create should return a clientId')
    assert(createdClient.apiKey, 'Admin create should return an apiKey')
    assert(createdClient.active === true, 'Admin create should return active=true')

    await step('GET /admin/clients', async () => {
      const body = await requestJson<{ data: Array<{ clientId: string }>; total: number }>(
        app,
        {
          method: 'GET',
          url: '/admin/clients',
          headers: adminHeaders,
        },
        200,
        'GET /admin/clients'
      )
      assert(body.total >= 1, 'Admin list should contain at least one client')
      assert(
        body.data.some((client) => client.clientId === createdClient.clientId),
        'Admin list should include the created client'
      )
    })

    await step('GET /admin/clients/:id', async () => {
      const body = await requestJson<{ clientId: string; name: string }>(
        app,
        {
          method: 'GET',
          url: `/admin/clients/${createdClient.clientId}`,
          headers: adminHeaders,
        },
        200,
        'GET /admin/clients/:id'
      )
      assert(body.clientId === createdClient.clientId, 'Admin show should return the correct client')
    })

    await step('PATCH /admin/clients/:id', async () => {
      const body = await requestJson<{ success: boolean; clientId: string; apiKey?: string }>(
        app,
        {
          method: 'PATCH',
          url: `/admin/clients/${createdClient.clientId}`,
          headers: adminHeaders,
          payload: {
            rotateKey: true,
            active: false,
          },
        },
        200,
        'PATCH /admin/clients/:id'
      )
      assert(body.success, 'Admin update should return success=true')
      assert(body.clientId === createdClient.clientId, 'Admin update should return the same client id')
      assert(body.apiKey, 'Admin rotateKey should return a new apiKey')
    })

    console.log('\nAll route tests passed.')
  } finally {
    await app.close()
    await closeDbAdapter()
  }
}

main().catch((error) => {
  console.error('\n[FAIL] Route test run failed.')
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
