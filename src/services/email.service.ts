// src/services/email.service.ts
import nodemailer from 'nodemailer'
import { config } from '../config'

interface EmailPayload {
  to: string
  subject: string
  html: string
}

function buildTransport() {
  if (config.email.provider === 'sendgrid') {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: {
        user: 'apikey',
        pass: config.email.sendgridApiKey,
      },
    })
  }

  // SMTP fallback
  return nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
  })
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  // In development with no credentials, just log
  if (
    config.server.nodeEnv === 'development' &&
    !config.email.sendgridApiKey &&
    !config.email.smtp.host
  ) {
    console.log('[EMAIL - DEV MODE]', {
      to: payload.to,
      subject: payload.subject,
    })
    return
  }

  const transport = buildTransport()
  await transport.sendMail({
    from: `"${config.email.fromName}" <${config.email.from}>`,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  })
}
