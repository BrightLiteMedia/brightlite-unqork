// src/services/otp.service.ts
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config'
import { getDbAdapter } from '../adapters'
import {
  OtpSendRequest,
  OtpSendResponse,
  OtpVerifyRequest,
  OtpVerifyResponse,
  OtpRecord,
} from '../types'
import { sendEmail } from './email.service'
import { sendSms } from './sms.service'

function generateCode(length: number): string {
  const digits = '0123456789'
  let code = ''
  for (let i = 0; i < length; i++) {
    code += digits[Math.floor(Math.random() * digits.length)]
  }
  return code
}

export async function sendOtp(req: OtpSendRequest): Promise<OtpSendResponse> {
  const db = getDbAdapter()
  const code = generateCode(config.otp.length)
  const tokenId = uuidv4()
  const expiresAt = new Date(
    Date.now() + config.otp.expirySeconds * 1000
  )

  const record: OtpRecord = {
    id: tokenId,
    clientId: req.clientId,
    channel: req.channel,
    destination: req.destination,
    code,
    expiresAt,
    used: false,
    createdAt: new Date(),
  }

  await db.saveOtp(record)

  const clientName = req.clientName ?? 'Our Company'
  const expiryMinutes = Math.round(config.otp.expirySeconds / 60)

  if (req.channel === 'email') {
    await sendEmail({
      to: req.destination,
      subject: `Your verification code – ${clientName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Verify your email</h2>
          <p>Your one-time verification code is:</p>
          <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px;
                      color: #2563eb; padding: 16px 0;">${code}</div>
          <p style="color: #666; font-size: 14px;">
            This code expires in ${expiryMinutes} minutes.<br/>
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    })
  } else {
    await sendSms({
      to: req.destination,
      body: `${clientName}: Your verification code is ${code}. Expires in ${expiryMinutes} minutes.`,
    })
  }

  return {
    success: true,
    tokenId,
    expiresAt,
    message: `Verification code sent via ${req.channel}`,
    ...(process.env.ROUTE_TEST_MODE === 'true' ? { debugCode: code } : {}),
  }
}

export async function verifyOtp(
  req: OtpVerifyRequest
): Promise<OtpVerifyResponse> {
  const db = getDbAdapter()
  const record = await db.getOtp(req.tokenId)

  if (!record) {
    return { valid: false, message: 'Invalid or expired token' }
  }
  if (record.used) {
    return { valid: false, message: 'This code has already been used' }
  }
  if (new Date() > record.expiresAt) {
    return { valid: false, message: 'This code has expired' }
  }
  if (record.code !== req.code) {
    return { valid: false, message: 'Incorrect code' }
  }

  await db.markOtpUsed(req.tokenId)

  return { valid: true, message: 'Verification successful' }
}
