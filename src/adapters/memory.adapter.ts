// src/adapters/memory.adapter.ts
// Default in-memory adapter — zero dependencies, perfect for dev/POC.
// Replace with postgres.adapter.ts / mongo.adapter.ts for production.

import {
  DbAdapter,
  OtpRecord,
  ContactSubmission,
  Appointment,
  ClientConfig,
  ClientConfigPublic,
  SubmissionFilters,
  AppointmentFilters,
  ClientConfigFilters,
  ListResult,
} from '../types'

export class MemoryAdapter implements DbAdapter {
  private otps         = new Map<string, OtpRecord>()
  private submissions  = new Map<string, ContactSubmission>()
  private appointments = new Map<string, Appointment>()
  private clients      = new Map<string, ClientConfig>()

  // ─── OTP ───────────────────────────────────────────────────────────────────

  async saveOtp(record: OtpRecord): Promise<void> {
    this.otps.set(record.id, record)
  }

  async getOtp(tokenId: string): Promise<OtpRecord | null> {
    return this.otps.get(tokenId) ?? null
  }

  async markOtpUsed(tokenId: string): Promise<void> {
    const record = this.otps.get(tokenId)
    if (record) this.otps.set(tokenId, { ...record, used: true })
  }

  // ─── Contact Submissions ───────────────────────────────────────────────────

  async saveSubmission(submission: ContactSubmission): Promise<void> {
    this.submissions.set(submission.id, submission)
  }

  async getSubmissions(filters?: SubmissionFilters): Promise<ListResult<ContactSubmission>> {
    let results = Array.from(this.submissions.values())
    if (filters?.clientId)  results = results.filter((s) => s.clientId === filters.clientId)
    if (filters?.status)    results = results.filter((s) => s.status === filters.status)
    if (filters?.category)  results = results.filter((s) => s.category === filters.category)
    if (filters?.search) {
      const needle = filters.search.toLowerCase()
      results = results.filter((s) =>
        [s.name, s.email, s.phone, s.message, s.routedTo]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle))
      )
    }
    results = results.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
    return { data: results, total: results.length }
  }

  async getSubmission(id: string): Promise<ContactSubmission | null> {
    return this.submissions.get(id) ?? null
  }

  async updateSubmission(id: string, updates: Partial<ContactSubmission>): Promise<void> {
    const existing = this.submissions.get(id)
    if (existing) this.submissions.set(id, { ...existing, ...updates })
  }

  // ─── Appointments ──────────────────────────────────────────────────────────

  async saveAppointment(appointment: Appointment): Promise<void> {
    this.appointments.set(appointment.id, appointment)
  }

  async getAppointments(filters?: AppointmentFilters): Promise<ListResult<Appointment>> {
    let results = Array.from(this.appointments.values())
    if (filters?.clientId) results = results.filter((a) => a.clientId === filters.clientId)
    if (filters?.date)     results = results.filter((a) => a.date === filters.date)
    if (filters?.status)   results = results.filter((a) => a.status === filters.status)
    if (filters?.search) {
      const needle = filters.search.toLowerCase()
      results = results.filter((a) =>
        [a.name, a.email, a.phone, a.serviceLabel, a.confirmationCode, a.notes]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle))
      )
    }
    results = results.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date)
      return dateCompare !== 0 ? dateCompare : a.time.localeCompare(b.time)
    })
    return { data: results, total: results.length }
  }

  async getAppointment(id: string): Promise<Appointment | null> {
    return this.appointments.get(id) ?? null
  }

  async updateAppointment(id: string, updates: Partial<Appointment>): Promise<void> {
    const existing = this.appointments.get(id)
    if (existing) {
      this.appointments.set(id, { ...existing, ...updates, updatedAt: new Date() })
    }
  }

  async getBookedSlots(
    date: string,
    clientId?: string
  ): Promise<{ time: string; durationMinutes: number }[]> {
    return Array.from(this.appointments.values())
      .filter((a) => {
        if (a.date !== date || a.status === 'cancelled') return false
        if (clientId && a.clientId !== clientId) return false
        return true
      })
      .map((a) => ({ time: a.time, durationMinutes: a.durationMinutes }))
  }

  // ─── Client Config (multi-tenant) ─────────────────────────────────────────

  async saveClientConfig(config: ClientConfig): Promise<void> {
    this.clients.set(config.clientId, config)
  }

  async getClientConfig(clientId: string): Promise<ClientConfig | null> {
    return this.clients.get(clientId) ?? null
  }

  async getClientConfigByApiKeyHash(apiKeyHash: string): Promise<ClientConfig | null> {
    for (const client of this.clients.values()) {
      if (client.apiKeyHash === apiKeyHash) return client
    }
    return null
  }

  async updateClientConfig(clientId: string, updates: Partial<ClientConfig>): Promise<void> {
    const existing = this.clients.get(clientId)
    if (existing) {
      this.clients.set(clientId, { ...existing, ...updates, updatedAt: new Date() })
    }
  }

  async listClientConfigs(filters?: ClientConfigFilters): Promise<ListResult<ClientConfigPublic>> {
    let results = Array.from(this.clients.values())
    if (filters?.search) {
      const needle = filters.search.toLowerCase()
      results = results.filter((client) =>
        [client.name, client.emailFrom, client.emailFromName]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle))
      )
    }

    const data = results.map(({ apiKeyHash: _omit, ...rest }) => rest)
    return { data, total: data.length }
  }
}
