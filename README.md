# Brightlite AI-powered intake and appointment scheduling middleware for Unquork

**AI-powered intake and appointment scheduling middleware**  
Built by [Brightlite Media Corporation](https://brightlitemedia.com)

Infrastructure-agnostic. Drop it into any client environment — AWS, Azure, GCP, OCI, or on-prem. Zero lock-in.

---

## What This Does

Two complete application flows, ready to wire into Unqork or any front-end:

| Flow | What It Handles |
|---|---|
| **Contact / Intake** | OTP-verified form submission, AI classification, sentiment scoring, spam detection, auto-routing, suggested reply draft |
| **Appointment Scheduling** | Service selection, real-time slot availability, OTP-verified booking, AI no-show risk scoring, smart natural language scheduling, confirmation via email + SMS |

---

## Quick Start (Local Dev)

```bash
# 1. Clone and install
git clone <your-repo>
cd brightlite-middleware
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set CLIENT_NAME.
# All external services (Twilio, SendGrid, AI) have dev-mode fallbacks
# that log to console instead of making real API calls.

# 3. Run
npm run dev
```

Server starts at **http://localhost:3000**  
Swagger API docs at **http://localhost:3000/docs**

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values.

### Minimal (dev/demo — no external services needed)
```env
NODE_ENV=development
DB_ADAPTER=memory
CLIENT_NAME=Acme Corp
```
All AI calls, emails, and SMS messages will be logged to the console instead of sent.

### Full Production
See `.env.example` for all options. Key sections:

| Section | Variables |
|---|---|
| **AI** | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| **SMS** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| **Email** | `EMAIL_PROVIDER`, `SENDGRID_API_KEY` or SMTP settings |
| **Database** | `DB_ADAPTER`, `POSTGRES_URL` / `MONGO_URL` |
| **Scheduling** | `APPOINTMENT_SERVICES`, `APPOINTMENT_AVAILABLE_DAYS`, times |
| **Routing** | `ROUTING_SALES`, `ROUTING_SUPPORT`, `ROUTING_BILLING` |

---

## API Reference

Full interactive docs at `/docs` (Swagger UI). Summary below.

### OTP (shared by both flows)

```
POST /otp/send
Body: { "channel": "email" | "sms", "destination": "user@example.com" }
→ Returns: { tokenId, expiresAt }

POST /otp/verify
Body: { "tokenId": "...", "code": "123456" }
→ Returns: { valid: true | false }
```

---

### Contact / Intake

```
POST /contact/submit
Body: { name, email, phone?, message, otpTokenId }
→ Returns: { submissionId, category, sentiment, isSpam }

GET  /contact/submissions?status=new&category=support
→ Returns: { data: [...], total }

GET  /contact/submissions/:id
PATCH /contact/submissions/:id
Body: { status?, internalNotes? }
```

**AI enrichment on every submission:**
- Category: `sales | support | billing | complaint | general | other`
- Sentiment: `positive | neutral | negative | urgent`
- Spam score (0–1) with auto-reject if flagged
- Suggested reply draft for the internal team
- Auto-routing to the correct team email

---

### Appointments

```
GET  /appointments/services
→ Returns configured services with durations

GET  /appointments/available-dates
→ Returns next 30 available dates (respects APPOINTMENT_AVAILABLE_DAYS)

GET  /appointments/slots?date=2025-05-01&serviceId=consultation
→ Returns all slots with available: true | false

POST /appointments/smart-schedule
Body: { naturalLanguageInput: "next Tuesday afternoon", serviceId, timezone }
→ Returns: { suggestions: [...], parsedIntent }

POST /appointments/book
Body: { name, email, phone?, serviceId, date, time, timezone, notes?, otpTokenId }
→ Returns: { appointmentId, confirmationCode, noShowRiskScore }

GET  /appointments?date=2025-05-01&status=confirmed
PATCH /appointments/:id
Body: { status?: "cancelled" | "rescheduled" | "completed" | "no_show" }

POST /appointments/detect-intent
Body: { message: "I need to reschedule" }
→ Returns: { wantsCancellation, wantsReschedule }
```

**AI enrichment on every booking:**
- No-show risk score (0–1) with `low | medium | high` label
- Extra SMS reminder automatically triggered for high-risk bookings
- Natural language scheduling intent parsing

---

## Typical Flow (Unqork Integration)

### Contact Form
```
Unqork Module 1 (Form)
  → POST /otp/send        (user enters email or phone)

Unqork Module 2 (OTP Entry)
  → POST /otp/verify      (user enters code)

Unqork Module 3 (Submit)
  → POST /contact/submit  (tokenId from step 1)

Unqork Module 4 (Dashboard)
  → GET  /contact/submissions
  → PATCH /contact/submissions/:id
```

### Appointment Scheduler
```
Unqork Module 1 (Booker Info + OTP)
  → POST /otp/send
  → POST /otp/verify

Unqork Module 2 (Service Selection)
  → GET  /appointments/services

Unqork Module 3 (Date + Time Picker)
  → GET  /appointments/available-dates
  → GET  /appointments/slots

  Optional smart schedule:
  → POST /appointments/smart-schedule

Unqork Module 4 (Confirm)
  → POST /appointments/book

Unqork Module 5 (Admin Dashboard)
  → GET  /appointments
  → PATCH /appointments/:id
```

---

## Swapping the AI Provider

Set `AI_PROVIDER` in `.env`:

```env
# Use Anthropic Claude (default)
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Use OpenAI
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

No code changes required. The AI service layer handles both providers transparently.

---

## Swapping the Database

Set `DB_ADAPTER` in `.env`:

```env
# Development / POC (default — no database needed)
DB_ADAPTER=memory

# PostgreSQL
DB_ADAPTER=postgres
POSTGRES_URL=postgresql://user:pass@host:5432/dbname

# MongoDB
DB_ADAPTER=mongodb
MONGO_URL=mongodb://user:pass@host:27017/dbname
```

> **Note:** The `postgres` and `mongodb` adapters are scaffolded stubs.
> Implement `src/adapters/postgres.adapter.ts` following the `DbAdapter`
> interface in `src/types/index.ts`.

---

## Deployment

### Docker (recommended)

```bash
# Build
docker build -t brightlite-middleware .

# Run
docker run \
  -p 3000:3000 \
  --env-file .env \
  brightlite-middleware
```

### Docker Compose (local dev)

```bash
docker-compose up
```

### AWS / Azure / GCP / OCI

Push the Docker image to the client's container registry and deploy as a container service. The app is stateless (when using an external DB adapter) and scales horizontally.

```bash
# Example: AWS ECR + ECS
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag brightlite-middleware <account>.dkr.ecr.<region>.amazonaws.com/brightlite-middleware:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/brightlite-middleware:latest
```

---

## Onboarding a New Client

1. Copy `.env.example` → `.env`
2. Fill in `CLIENT_NAME`, `CLIENT_TIMEZONE`
3. Set `APPOINTMENT_SERVICES` (JSON array of services)
4. Set `APPOINTMENT_AVAILABLE_DAYS`, `START_TIME`, `END_TIME`
5. Set routing emails (`ROUTING_SALES`, `ROUTING_SUPPORT`, etc.)
6. Plug in API keys (Twilio, SendGrid, AI provider)
7. Set `DB_ADAPTER` and connection string
8. Deploy container
9. Import Unqork template into client's Unqork instance
10. Point Unqork API integrations at the deployed middleware URL

**Total onboarding time: 2–4 hours**

---

## Project Structure

```
src/
├── server.ts              # Fastify app, plugins, route registration
├── config/index.ts        # Typed config from environment variables
├── types/index.ts         # Shared TypeScript interfaces
├── adapters/
│   ├── index.ts           # Adapter factory
│   └── memory.adapter.ts  # In-memory adapter (dev default)
├── services/
│   ├── otp.service.ts     # OTP generation, delivery, verification
│   ├── email.service.ts   # SendGrid + SMTP abstraction
│   ├── sms.service.ts     # Twilio SMS
│   └── ai.service.ts      # Claude + OpenAI abstraction
├── utils/
│   └── scheduling.ts      # Slot generation, availability logic
└── routes/
    ├── otp.routes.ts
    ├── contact.routes.ts
    └── appointment.routes.ts
```

---

## Extending the Middleware

### Adding a new database adapter
1. Create `src/adapters/postgres.adapter.ts`
2. Implement the `DbAdapter` interface from `src/types/index.ts`
3. Add a `case 'postgres':` in `src/adapters/index.ts`

### Adding a new AI feature
1. Add a new function in `src/services/ai.service.ts`
2. Call it from the relevant route handler
3. Both Claude and OpenAI are available through the same `callAi()` helper

### Adding a new route
1. Create `src/routes/your-feature.routes.ts`
2. Export an async Fastify plugin function
3. Register it in `src/server.ts`

---

## Security Notes

- OTP codes expire after `OTP_EXPIRY_SECONDS` (default 5 minutes)
- Each OTP token can only be used once (marked `used` after verification)
- Rate limiting is applied globally (100 req/min) with tighter limits on `/otp/*`
- Helmet sets secure HTTP headers on every response
- The Docker image runs as a non-root user (`brightlite`)
- No sensitive data is logged — only metadata (to, subject, not code values)

---

## License

Proprietary — Brightlite Media Corporation  
Not for redistribution without written permission.
