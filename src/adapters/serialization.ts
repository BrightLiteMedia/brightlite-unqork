import {
  Appointment,
  ClientConfig,
  ClientConfigPublic,
  ContactSubmission,
  OtpRecord,
} from '../types'

type JsonRecord = Record<string, unknown>

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value)
}

export function serializeOtpRecord(record: OtpRecord): string {
  return stringifyJson({
    ...record,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  })
}

export function deserializeOtpRecord(value: string): OtpRecord {
  const record = parseJson<OtpRecord & { expiresAt: string; createdAt: string }>(value)
  return {
    ...record,
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
  }
}

export function serializeContactSubmission(submission: ContactSubmission): string {
  return stringifyJson({
    ...submission,
    submittedAt: submission.submittedAt.toISOString(),
  })
}

export function deserializeContactSubmission(value: string): ContactSubmission {
  const submission = parseJson<ContactSubmission & { submittedAt: string }>(value)
  return {
    ...submission,
    submittedAt: new Date(submission.submittedAt),
  }
}

export function serializeAppointment(appointment: Appointment): string {
  return stringifyJson({
    ...appointment,
    createdAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString(),
  })
}

export function deserializeAppointment(value: string): Appointment {
  const appointment = parseJson<Appointment & { createdAt: string; updatedAt: string }>(value)
  return {
    ...appointment,
    createdAt: new Date(appointment.createdAt),
    updatedAt: new Date(appointment.updatedAt),
  }
}

export function serializeClientConfig(config: ClientConfig): string {
  return stringifyJson({
    ...config,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  })
}

export function deserializeClientConfig(value: string): ClientConfig {
  const config = parseJson<ClientConfig & { createdAt: string; updatedAt: string }>(value)
  return {
    ...config,
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  }
}

export function serializeClientConfigPublic(config: ClientConfigPublic): JsonRecord {
  return {
    ...config,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  }
}

export function deserializeClientConfigPublic(value: JsonRecord): ClientConfigPublic {
  return {
    ...value,
    createdAt: new Date(String(value.createdAt)),
    updatedAt: new Date(String(value.updatedAt)),
  } as ClientConfigPublic
}
