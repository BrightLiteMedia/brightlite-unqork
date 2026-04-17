// src/types/index.ts
// Shared types across the entire middleware

// ─── Multi-tenant Client Config ───────────────────────────────────────────────

export interface ClientRoutingConfig {
  sales: string
  support: string
  billing: string
  general: string
}

export interface ClientConfig {
  clientId: string
  apiKeyHash: string          // SHA-256 of the plaintext API key — never returned in responses
  name: string
  timezone: string
  services: AppointmentService[]
  availableDays: number[]     // 0=Sun … 6=Sat
  startTime: string           // "HH:MM"
  endTime: string             // "HH:MM"
  slotIntervalMinutes: number
  emailFrom: string
  emailFromName: string
  routing: ClientRoutingConfig
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type ClientConfigPublic = Omit<ClientConfig, 'apiKeyHash'>

export interface ListResult<T> {
  data: T[]
  total: number
}

export interface SubmissionFilters {
  status?: InquiryStatus
  category?: InquiryCategory
  clientId?: string
  search?: string
}

export interface AppointmentFilters {
  date?: string
  status?: AppointmentStatus
  clientId?: string
  search?: string
}

export interface ClientConfigFilters {
  search?: string
}

// Passed into scheduling utils so they don't depend on global config
export interface SchedulingConfig {
  availableDays: number[]
  startTime: string
  endTime: string
  slotIntervalMinutes: number
}

// ─── OTP ─────────────────────────────────────────────────────────────────────

export type OtpChannel = 'email' | 'sms'

export interface OtpRecord {
  id: string
  clientId: string            // scopes the token to a specific client
  channel: OtpChannel
  destination: string         // email address or phone number
  code: string
  expiresAt: Date
  used: boolean
  createdAt: Date
}

export interface OtpSendRequest {
  channel: OtpChannel
  destination: string   // email or phone
  clientId: string
  clientName?: string   // used in the message template
}

export interface OtpSendResponse {
  success: boolean
  tokenId: string       // returned to client to use in verify step
  expiresAt: Date
  message: string
  debugCode?: string    // exposed only in explicit test mode
}

export interface OtpVerifyRequest {
  tokenId: string
  code: string
}

export interface OtpVerifyResponse {
  valid: boolean
  message: string
}

// ─── Contact / Intake ─────────────────────────────────────────────────────────

export type InquiryStatus = 'new' | 'in_progress' | 'resolved'
export type SentimentLabel = 'positive' | 'neutral' | 'negative' | 'urgent'
export type InquiryCategory = 'sales' | 'support' | 'billing' | 'general' | 'complaint' | 'other'

export interface ContactSubmission {
  id: string
  clientId: string            // tenant scope
  name: string
  email: string
  phone?: string
  message: string
  otpTokenId: string          // must be verified before submission is accepted
  submittedAt: Date
  // AI-enriched fields (populated after submission)
  category?: InquiryCategory
  sentiment?: SentimentLabel
  sentimentScore?: number     // 0-1 confidence
  spamScore?: number          // 0-1 probability of spam
  isSpam?: boolean
  suggestedReply?: string
  routedTo?: string           // email of the team/person it was routed to
  status: InquiryStatus
  internalNotes?: string
}

export interface ContactSubmitRequest {
  name: string
  email: string
  phone?: string
  message: string
  otpTokenId: string
}

export interface ContactSubmitResponse {
  success: boolean
  submissionId: string
  category: InquiryCategory
  sentiment: SentimentLabel
  isSpam: boolean
  message: string
}

// ─── Appointments ─────────────────────────────────────────────────────────────

export type AppointmentStatus = 'pending' | 'confirmed' | 'cancelled' | 'rescheduled' | 'completed' | 'no_show'

export interface AppointmentService {
  id: string
  label: string
  durationMinutes: number
}

export interface TimeSlot {
  date: string          // YYYY-MM-DD
  time: string          // HH:MM (24hr)
  available: boolean
}

export interface Appointment {
  id: string
  clientId: string            // tenant scope
  name: string
  email: string
  phone?: string
  serviceId: string
  serviceLabel: string
  durationMinutes: number
  date: string          // YYYY-MM-DD
  time: string          // HH:MM (24hr)
  timezone: string
  notes?: string
  otpTokenId: string
  status: AppointmentStatus
  noShowRiskScore?: number    // 0-1 AI-generated
  confirmationCode: string
  createdAt: Date
  updatedAt: Date
}

export interface BookingRequest {
  name: string
  email: string
  phone?: string
  serviceId: string
  date: string
  time: string
  timezone: string
  notes?: string
  otpTokenId: string
}

export interface BookingResponse {
  success: boolean
  appointmentId: string
  confirmationCode: string
  noShowRiskScore: number
  message: string
}

export interface SmartScheduleSuggestion {
  date: string
  time: string
  label: string         // e.g. "Tomorrow at 2:00 PM"
}

export interface SmartScheduleRequest {
  naturalLanguageInput: string    // e.g. "next Tuesday afternoon"
  serviceId: string
  timezone: string
}

export interface SmartScheduleResponse {
  suggestions: SmartScheduleSuggestion[]
  parsedIntent: string
}

// ─── AI ──────────────────────────────────────────────────────────────────────

export interface AiClassifyResult {
  category: InquiryCategory
  sentiment: SentimentLabel
  sentimentScore: number
  isSpam: boolean
  spamScore: number
  suggestedReply: string
  routingEmail: string
}

export interface AiNoShowResult {
  riskScore: number
  riskLabel: 'low' | 'medium' | 'high'
  reasoning: string
}

// ─── DB Adapter ───────────────────────────────────────────────────────────────

export interface DbAdapter {
  // OTP
  saveOtp(record: OtpRecord): Promise<void>
  getOtp(tokenId: string): Promise<OtpRecord | null>
  markOtpUsed(tokenId: string): Promise<void>

  // Contact — all queries scoped by clientId when provided
  saveSubmission(submission: ContactSubmission): Promise<void>
  getSubmissions(filters?: SubmissionFilters): Promise<ListResult<ContactSubmission>>
  getSubmission(id: string): Promise<ContactSubmission | null>
  updateSubmission(id: string, updates: Partial<ContactSubmission>): Promise<void>

  // Appointments — all queries scoped by clientId when provided
  saveAppointment(appointment: Appointment): Promise<void>
  getAppointments(filters?: AppointmentFilters): Promise<ListResult<Appointment>>
  getAppointment(id: string): Promise<Appointment | null>
  updateAppointment(id: string, updates: Partial<Appointment>): Promise<void>
  getBookedSlots(date: string, clientId?: string): Promise<{ time: string; durationMinutes: number }[]>

  // Client Config (multi-tenant)
  saveClientConfig(config: ClientConfig): Promise<void>
  getClientConfig(clientId: string): Promise<ClientConfig | null>
  getClientConfigByApiKeyHash(apiKeyHash: string): Promise<ClientConfig | null>
  updateClientConfig(clientId: string, updates: Partial<ClientConfig>): Promise<void>
  listClientConfigs(filters?: ClientConfigFilters): Promise<ListResult<ClientConfigPublic>>
}
