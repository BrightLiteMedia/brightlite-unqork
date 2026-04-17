// src/adapters/postgres.adapter.ts
// Production PostgreSQL adapter.
// Install pg: npm install pg @types/pg
// Set DB_ADAPTER=postgres and POSTGRES_URL in .env

// import { Pool } from 'pg'
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
// import { config } from '../config'

// ─── Schema (run once on first deploy) ────────────────────────────────────────
//
// CREATE TABLE client_configs (
//   client_id UUID PRIMARY KEY,
//   api_key_hash TEXT NOT NULL UNIQUE,
//   name TEXT NOT NULL,
//   timezone TEXT NOT NULL DEFAULT 'America/Chicago',
//   services JSONB NOT NULL DEFAULT '[]',
//   available_days JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
//   start_time TEXT NOT NULL DEFAULT '09:00',
//   end_time TEXT NOT NULL DEFAULT '17:00',
//   slot_interval_minutes INT NOT NULL DEFAULT 30,
//   email_from TEXT NOT NULL,
//   email_from_name TEXT NOT NULL,
//   routing JSONB NOT NULL DEFAULT '{}',
//   active BOOLEAN NOT NULL DEFAULT TRUE,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE TABLE otp_tokens (
//   id UUID PRIMARY KEY,
//   client_id UUID NOT NULL REFERENCES client_configs(client_id),
//   channel VARCHAR(10) NOT NULL,
//   destination TEXT NOT NULL,
//   code VARCHAR(10) NOT NULL,
//   expires_at TIMESTAMPTZ NOT NULL,
//   used BOOLEAN DEFAULT FALSE,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE TABLE contact_submissions (
//   id UUID PRIMARY KEY,
//   client_id UUID NOT NULL REFERENCES client_configs(client_id),
//   name TEXT NOT NULL,
//   email TEXT NOT NULL,
//   phone TEXT,
//   message TEXT NOT NULL,
//   otp_token_id UUID NOT NULL,
//   submitted_at TIMESTAMPTZ DEFAULT NOW(),
//   category VARCHAR(20),
//   sentiment VARCHAR(20),
//   sentiment_score FLOAT,
//   spam_score FLOAT,
//   is_spam BOOLEAN DEFAULT FALSE,
//   suggested_reply TEXT,
//   routed_to TEXT,
//   status VARCHAR(20) DEFAULT 'new',
//   internal_notes TEXT
// );
//
// CREATE TABLE appointments (
//   id UUID PRIMARY KEY,
//   client_id UUID NOT NULL REFERENCES client_configs(client_id),
//   name TEXT NOT NULL,
//   email TEXT NOT NULL,
//   phone TEXT,
//   service_id TEXT NOT NULL,
//   service_label TEXT NOT NULL,
//   duration_minutes INT NOT NULL,
//   date DATE NOT NULL,
//   time TIME NOT NULL,
//   timezone TEXT NOT NULL,
//   notes TEXT,
//   otp_token_id UUID NOT NULL,
//   status VARCHAR(20) DEFAULT 'confirmed',
//   no_show_risk_score FLOAT,
//   confirmation_code VARCHAR(10) NOT NULL,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE INDEX idx_otp_client       ON otp_tokens(client_id);
// CREATE INDEX idx_submissions_client ON contact_submissions(client_id, status);
// CREATE INDEX idx_appointments_client ON appointments(client_id, date);

export class PostgresAdapter implements DbAdapter {
  // private pool: Pool

  constructor() {
    // this.pool = new Pool({ connectionString: config.db.postgresUrl })
    throw new Error(
      'PostgresAdapter: uncomment the pg imports and implement the methods. ' +
      'See the SQL schema comments in this file.'
    )
  }

  async saveOtp(_record: OtpRecord): Promise<void> { throw new Error('Not implemented') }
  async getOtp(_tokenId: string): Promise<OtpRecord | null> { throw new Error('Not implemented') }
  async markOtpUsed(_tokenId: string): Promise<void> { throw new Error('Not implemented') }

  async saveSubmission(_submission: ContactSubmission): Promise<void> { throw new Error('Not implemented') }
  async getSubmissions(_filters?: SubmissionFilters): Promise<ListResult<ContactSubmission>> { throw new Error('Not implemented') }
  async getSubmission(_id: string): Promise<ContactSubmission | null> { throw new Error('Not implemented') }
  async updateSubmission(_id: string, _updates: Partial<ContactSubmission>): Promise<void> { throw new Error('Not implemented') }

  async saveAppointment(_appointment: Appointment): Promise<void> { throw new Error('Not implemented') }
  async getAppointments(_filters?: AppointmentFilters): Promise<ListResult<Appointment>> { throw new Error('Not implemented') }
  async getAppointment(_id: string): Promise<Appointment | null> { throw new Error('Not implemented') }
  async updateAppointment(_id: string, _updates: Partial<Appointment>): Promise<void> { throw new Error('Not implemented') }
  async getBookedSlots(_date: string, _clientId?: string): Promise<{ time: string; durationMinutes: number }[]> { throw new Error('Not implemented') }

  async saveClientConfig(_config: ClientConfig): Promise<void> { throw new Error('Not implemented') }
  async getClientConfig(_clientId: string): Promise<ClientConfig | null> { throw new Error('Not implemented') }
  async getClientConfigByApiKeyHash(_hash: string): Promise<ClientConfig | null> { throw new Error('Not implemented') }
  async updateClientConfig(_clientId: string, _updates: Partial<ClientConfig>): Promise<void> { throw new Error('Not implemented') }
  async listClientConfigs(_filters?: ClientConfigFilters): Promise<ListResult<ClientConfigPublic>> { throw new Error('Not implemented') }
}
