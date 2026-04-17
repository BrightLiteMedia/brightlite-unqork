import Redis from 'ioredis'
import { config } from '../config'
import {
  Appointment,
  AppointmentFilters,
  ClientConfig,
  ClientConfigFilters,
  ClientConfigPublic,
  ContactSubmission,
  DbAdapter,
  ListResult,
  OtpRecord,
  SubmissionFilters,
} from '../types'
import { MongoDbAdapter } from './mongodb.adapter'
import {
  deserializeAppointment,
  deserializeClientConfig,
  deserializeContactSubmission,
  deserializeOtpRecord,
  serializeAppointment,
  serializeClientConfig,
  serializeContactSubmission,
  serializeOtpRecord,
} from './serialization'

type QueueEntity = 'otp' | 'submission' | 'appointment' | 'client'

export class RedisWriteBehindAdapter implements DbAdapter {
  private readonly redis: Redis
  private readonly mongo: MongoDbAdapter

  constructor(mongo = new MongoDbAdapter()) {
    if (!config.db.redisUrl) {
      throw new Error('REDIS_URL must be set to use the Redis write-behind adapter')
    }

    this.redis = new Redis(config.db.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
    })
    this.mongo = mongo
  }

  private otpKey(id: string): string {
    return `otp:${id}`
  }

  private submissionKey(id: string): string {
    return `submission:${id}`
  }

  private appointmentKey(id: string): string {
    return `appointment:${id}`
  }

  private clientKey(id: string): string {
    return `client:${id}`
  }

  private clientApiKeyHashKey(hash: string): string {
    return `client:apiKeyHash:${hash}`
  }

  private submissionIdsKey(clientId?: string): string {
    return clientId ? `submissions:client:${clientId}` : 'submissions:all'
  }

  private appointmentIdsKey(clientId?: string): string {
    return clientId ? `appointments:client:${clientId}` : 'appointments:all'
  }

  private appointmentDateIdsKey(date: string, clientId?: string): string {
    return clientId ? `appointments:client:${clientId}:date:${date}` : `appointments:date:${date}`
  }

  private clientIdsKey(): string {
    return 'clients:all'
  }

  private async enqueue(entity: QueueEntity, payload: unknown): Promise<void> {
    await this.redis.xadd(
      config.db.redisWriteStream,
      '*',
      'entity',
      entity,
      'payload',
      JSON.stringify(payload)
    )
  }

  private otpTtlSeconds(record: OtpRecord): number {
    const remaining = Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000)
    return Math.max(remaining + 300, 60)
  }

  private async cacheOtp(record: OtpRecord): Promise<void> {
    await this.redis.set(this.otpKey(record.id), serializeOtpRecord(record), 'EX', this.otpTtlSeconds(record))
  }

  private async cacheSubmission(submission: ContactSubmission): Promise<void> {
    await this.redis.set(this.submissionKey(submission.id), serializeContactSubmission(submission))
    await this.redis.sadd(this.submissionIdsKey(), submission.id)
    await this.redis.sadd(this.submissionIdsKey(submission.clientId), submission.id)
  }

  private async cacheAppointment(appointment: Appointment): Promise<void> {
    await this.redis.set(this.appointmentKey(appointment.id), serializeAppointment(appointment))
    await this.redis.sadd(this.appointmentIdsKey(), appointment.id)
    await this.redis.sadd(this.appointmentIdsKey(appointment.clientId), appointment.id)
    await this.redis.sadd(this.appointmentDateIdsKey(appointment.date), appointment.id)
    await this.redis.sadd(this.appointmentDateIdsKey(appointment.date, appointment.clientId), appointment.id)
  }

  private async removeAppointmentIndexes(appointment: Appointment): Promise<void> {
    await this.redis.srem(this.appointmentDateIdsKey(appointment.date), appointment.id)
    await this.redis.srem(this.appointmentDateIdsKey(appointment.date, appointment.clientId), appointment.id)
  }

  private async cacheClient(configRecord: ClientConfig): Promise<void> {
    await this.redis.set(this.clientKey(configRecord.clientId), serializeClientConfig(configRecord))
    await this.redis.set(this.clientApiKeyHashKey(configRecord.apiKeyHash), configRecord.clientId)
    await this.redis.sadd(this.clientIdsKey(), configRecord.clientId)
  }

  private async getMany<T>(
    ids: string[],
    keyForId: (id: string) => string,
    deserialize: (value: string) => T
  ): Promise<T[]> {
    if (ids.length === 0) return []
    const values = await this.redis.mget(ids.map((id) => keyForId(id)))
    return values.filter((value): value is string => Boolean(value)).map(deserialize)
  }

  async saveOtp(record: OtpRecord): Promise<void> {
    await this.cacheOtp(record)
    await this.enqueue('otp', record)
  }

  async getOtp(tokenId: string): Promise<OtpRecord | null> {
    const cached = await this.redis.get(this.otpKey(tokenId))
    if (cached) return deserializeOtpRecord(cached)

    const record = await this.mongo.getOtp(tokenId)
    if (record) await this.cacheOtp(record)
    return record
  }

  async markOtpUsed(tokenId: string): Promise<void> {
    const existing = await this.getOtp(tokenId)
    if (!existing) return

    const updated: OtpRecord = { ...existing, used: true }
    await this.cacheOtp(updated)
    await this.enqueue('otp', updated)
  }

  async saveSubmission(submission: ContactSubmission): Promise<void> {
    await this.cacheSubmission(submission)
    await this.enqueue('submission', submission)
  }

  async getSubmissions(filters?: SubmissionFilters): Promise<ListResult<ContactSubmission>> {
    if (filters?.search) {
      return this.mongo.getSubmissions(filters)
    }

    const ids = await this.redis.smembers(this.submissionIdsKey(filters?.clientId))
    if (ids.length === 0) {
      const result = await this.mongo.getSubmissions(filters)
      await Promise.all(result.data.map((submission) => this.cacheSubmission(submission)))
      return result
    }

    let submissions = await this.getMany(ids, (id) => this.submissionKey(id), deserializeContactSubmission)
    if (filters?.clientId) submissions = submissions.filter((submission) => submission.clientId === filters.clientId)
    if (filters?.status) submissions = submissions.filter((submission) => submission.status === filters.status)
    if (filters?.category) submissions = submissions.filter((submission) => submission.category === filters.category)

    submissions.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
    return { data: submissions, total: submissions.length }
  }

  async getSubmission(id: string): Promise<ContactSubmission | null> {
    const cached = await this.redis.get(this.submissionKey(id))
    if (cached) return deserializeContactSubmission(cached)

    const submission = await this.mongo.getSubmission(id)
    if (submission) await this.cacheSubmission(submission)
    return submission
  }

  async updateSubmission(id: string, updates: Partial<ContactSubmission>): Promise<void> {
    const existing = await this.getSubmission(id)
    if (!existing) return

    const updated: ContactSubmission = { ...existing, ...updates }
    await this.cacheSubmission(updated)
    await this.enqueue('submission', updated)
  }

  async saveAppointment(appointment: Appointment): Promise<void> {
    await this.cacheAppointment(appointment)
    await this.enqueue('appointment', appointment)
  }

  async getAppointments(filters?: AppointmentFilters): Promise<ListResult<Appointment>> {
    if (filters?.search) {
      return this.mongo.getAppointments(filters)
    }

    const ids = await this.redis.smembers(this.appointmentIdsKey(filters?.clientId))
    if (ids.length === 0) {
      const result = await this.mongo.getAppointments(filters)
      await Promise.all(result.data.map((appointment) => this.cacheAppointment(appointment)))
      return result
    }

    let appointments = await this.getMany(ids, (id) => this.appointmentKey(id), deserializeAppointment)
    if (filters?.clientId) appointments = appointments.filter((appointment) => appointment.clientId === filters.clientId)
    if (filters?.date) appointments = appointments.filter((appointment) => appointment.date === filters.date)
    if (filters?.status) appointments = appointments.filter((appointment) => appointment.status === filters.status)

    appointments.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date)
      return dateCompare !== 0 ? dateCompare : a.time.localeCompare(b.time)
    })

    return { data: appointments, total: appointments.length }
  }

  async getAppointment(id: string): Promise<Appointment | null> {
    const cached = await this.redis.get(this.appointmentKey(id))
    if (cached) return deserializeAppointment(cached)

    const appointment = await this.mongo.getAppointment(id)
    if (appointment) await this.cacheAppointment(appointment)
    return appointment
  }

  async updateAppointment(id: string, updates: Partial<Appointment>): Promise<void> {
    const existing = await this.getAppointment(id)
    if (!existing) return

    const updated: Appointment = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    }

    if (existing.date !== updated.date || existing.clientId !== updated.clientId) {
      await this.removeAppointmentIndexes(existing)
    }

    await this.cacheAppointment(updated)
    await this.enqueue('appointment', updated)
  }

  async getBookedSlots(date: string, clientId?: string): Promise<{ time: string; durationMinutes: number }[]> {
    const ids = await this.redis.smembers(this.appointmentDateIdsKey(date, clientId))
    if (ids.length === 0) {
      const result = await this.mongo.getAppointments({ date, clientId })
      await Promise.all(result.data.map((appointment) => this.cacheAppointment(appointment)))
      return result.data
        .filter((appointment) => appointment.status !== 'cancelled')
        .map((appointment) => ({
          time: appointment.time,
          durationMinutes: appointment.durationMinutes,
        }))
    }

    const appointments = await this.getMany(ids, (id) => this.appointmentKey(id), deserializeAppointment)
    return appointments
      .filter((appointment) => appointment.date === date)
      .filter((appointment) => !clientId || appointment.clientId === clientId)
      .filter((appointment) => appointment.status !== 'cancelled')
      .map((appointment) => ({
        time: appointment.time,
        durationMinutes: appointment.durationMinutes,
      }))
  }

  async saveClientConfig(configRecord: ClientConfig): Promise<void> {
    await this.cacheClient(configRecord)
    await this.enqueue('client', configRecord)
  }

  async getClientConfig(clientId: string): Promise<ClientConfig | null> {
    const cached = await this.redis.get(this.clientKey(clientId))
    if (cached) return deserializeClientConfig(cached)

    const client = await this.mongo.getClientConfig(clientId)
    if (client) await this.cacheClient(client)
    return client
  }

  async getClientConfigByApiKeyHash(apiKeyHash: string): Promise<ClientConfig | null> {
    const clientId = await this.redis.get(this.clientApiKeyHashKey(apiKeyHash))
    if (clientId) {
      return this.getClientConfig(clientId)
    }

    const client = await this.mongo.getClientConfigByApiKeyHash(apiKeyHash)
    if (client) await this.cacheClient(client)
    return client
  }

  async updateClientConfig(clientId: string, updates: Partial<ClientConfig>): Promise<void> {
    const existing = await this.getClientConfig(clientId)
    if (!existing) return

    const updated: ClientConfig = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    }

    if (existing.apiKeyHash !== updated.apiKeyHash) {
      await this.redis.del(this.clientApiKeyHashKey(existing.apiKeyHash))
    }

    await this.cacheClient(updated)
    await this.enqueue('client', updated)
  }

  async listClientConfigs(filters?: ClientConfigFilters): Promise<ListResult<ClientConfigPublic>> {
    if (filters?.search) {
      return this.mongo.listClientConfigs(filters)
    }

    const ids = await this.redis.smembers(this.clientIdsKey())
    if (ids.length === 0) {
      const result = await this.mongo.listClientConfigs()
      const clients = await Promise.all(
        result.data.map((client) => this.mongo.getClientConfig(client.clientId))
      )
      await Promise.all(
        clients.filter((client): client is ClientConfig => Boolean(client)).map((client) => this.cacheClient(client))
      )
      return result
    }

    const clients = await this.getMany(ids, (id) => this.clientKey(id), deserializeClientConfig)
    const data = clients
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ apiKeyHash: _omit, ...rest }) => rest)

    return { data, total: data.length }
  }

  async close(): Promise<void> {
    await this.redis.quit()
    await this.mongo.close()
  }
}
