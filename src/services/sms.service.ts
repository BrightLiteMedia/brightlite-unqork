// src/services/sms.service.ts
import twilio from 'twilio'
import { config } from '../config'

interface SmsPayload {
  to: string
  body: string
}

export async function sendSms(payload: SmsPayload): Promise<void> {
  // In development with no credentials, just log
  if (
    config.server.nodeEnv === 'development' &&
    !config.twilio.accountSid
  ) {
    console.log('[SMS - DEV MODE]', {
      to: payload.to,
      body: payload.body,
    })
    return
  }

  const client = twilio(config.twilio.accountSid, config.twilio.authToken)

  await client.messages.create({
    from: config.twilio.fromNumber,
    to: payload.to,
    body: payload.body,
  })
}
