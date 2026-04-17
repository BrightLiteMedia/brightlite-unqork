// src/services/ai.service.ts
// Abstracted AI provider layer.
// Swap between Anthropic and OpenAI via AI_PROVIDER env var.
// Neither the routes nor the business logic import from a specific SDK.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { config } from '../config'
import {
  AiClassifyResult,
  AiNoShowResult,
  InquiryCategory,
  SentimentLabel,
  SmartScheduleSuggestion,
} from '../types'

// ─── Provider abstraction ─────────────────────────────────────────────────────

async function callAi(prompt: string, systemPrompt: string): Promise<string> {
  if (config.ai.provider === 'anthropic') {
    if (!config.ai.anthropicApiKey) {
      return mockAiResponse(prompt)
    }
    const client = new Anthropic({ apiKey: config.ai.anthropicApiKey })
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = msg.content[0]
    return block.type === 'text' ? block.text : ''
  }

  // OpenAI fallback
  if (!config.ai.openaiApiKey) {
    return mockAiResponse(prompt)
  }
  const client = new OpenAI({ apiKey: config.ai.openaiApiKey })
  const completion = await client.chat.completions.create({
    model: config.ai.openaiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    max_tokens: 1024,
  })
  return completion.choices[0]?.message?.content ?? ''
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean) as T
  } catch {
    return fallback
  }
}

// Dev-mode mock so the server runs without real API keys
function mockAiResponse(prompt: string): string {
  const normalizedPrompt = prompt.toLowerCase()

  if (normalizedPrompt.includes('classify')) {
    return JSON.stringify({
      category: 'general',
      sentiment: 'neutral',
      sentimentScore: 0.5,
      isSpam: false,
      spamScore: 0.02,
      suggestedReply:
        'Thank you for reaching out. A member of our team will get back to you shortly.',
      routingEmail: config.routing.general,
    })
  }
  if (normalizedPrompt.includes('no-show')) {
    return JSON.stringify({
      riskScore: 0.2,
      riskLabel: 'low',
      reasoning: 'Booking made well in advance, no prior history.',
    })
  }
  if (normalizedPrompt.includes('cancel or reschedule')) {
    return JSON.stringify({
      wantsCancellation: false,
      wantsReschedule: true,
    })
  }
  if (normalizedPrompt.includes('schedule')) {
    return JSON.stringify({
      suggestions: [],
      parsedIntent: 'Could not parse intent in dev mode',
    })
  }
  return '{}'
}

// ─── Classification & Sentiment ───────────────────────────────────────────────

export async function classifySubmission(
  name: string,
  message: string,
  routingMap: Record<string, string>
): Promise<AiClassifyResult> {
  const systemPrompt = `You are an intake classification assistant. 
Respond ONLY with valid JSON. No markdown, no explanation.`

  const prompt = `Classify this customer inquiry and return JSON with these exact fields:
- category: one of "sales" | "support" | "billing" | "general" | "complaint" | "other"
- sentiment: one of "positive" | "neutral" | "negative" | "urgent"  
- sentimentScore: number 0-1 (confidence in sentiment)
- isSpam: boolean
- spamScore: number 0-1 (probability this is spam)
- suggestedReply: string (a brief, professional reply draft in 2-3 sentences)
- routingEmail: string (pick the best email from this map: ${JSON.stringify(routingMap)})

Sender name: ${name}
Message: "${message}"`

  const raw = await callAi(prompt, systemPrompt)

  const fallback: AiClassifyResult = {
    category: 'general' as InquiryCategory,
    sentiment: 'neutral' as SentimentLabel,
    sentimentScore: 0.5,
    isSpam: false,
    spamScore: 0,
    suggestedReply: 'Thank you for reaching out. We will be in touch shortly.',
    routingEmail: routingMap.general ?? '',
  }

  return parseJson<AiClassifyResult>(raw, fallback)
}

// ─── No-Show Risk Scoring ─────────────────────────────────────────────────────

export async function scoreNoShowRisk(
  appointment: {
    serviceLabel: string
    date: string
    time: string
    durationMinutes: number
    daysBetweenBookingAndAppointment: number
    notes?: string
  }
): Promise<AiNoShowResult> {
  const systemPrompt = `You are an appointment analytics assistant.
Respond ONLY with valid JSON. No markdown, no explanation.`

  const prompt = `Score the no-show risk for this appointment and return JSON with:
- riskScore: number 0-1 (0 = very likely to show, 1 = very likely to no-show)
- riskLabel: one of "low" | "medium" | "high"
- reasoning: string (one sentence explanation)

Appointment details:
- Service: ${appointment.serviceLabel}
- Date: ${appointment.date} at ${appointment.time}
- Duration: ${appointment.durationMinutes} minutes
- Days until appointment: ${appointment.daysBetweenBookingAndAppointment}
- Notes: ${appointment.notes ?? 'none'}`

  const raw = await callAi(prompt, systemPrompt)

  return parseJson<AiNoShowResult>(raw, {
    riskScore: 0.2,
    riskLabel: 'low',
    reasoning: 'Default low risk assigned.',
  })
}

// ─── Smart Scheduling ────────────────────────────────────────────────────────

export async function parseSchedulingIntent(
  naturalLanguageInput: string,
  availableSlots: SmartScheduleSuggestion[]
): Promise<{ suggestions: SmartScheduleSuggestion[]; parsedIntent: string }> {
  const systemPrompt = `You are a scheduling assistant.
Respond ONLY with valid JSON. No markdown, no explanation.`

  const prompt = `A user wants to schedule an appointment. Parse their intent and suggest up to 3 slots.

User input: "${naturalLanguageInput}"

Available slots (pick from these only):
${JSON.stringify(availableSlots, null, 2)}

Return JSON with:
- parsedIntent: string (describe what you understood, e.g. "Next Tuesday afternoon")  
- suggestions: array of up to 3 slots from the available list that best match the intent
  Each suggestion: { date: "YYYY-MM-DD", time: "HH:MM", label: "human-friendly string" }`

  const raw = await callAi(prompt, systemPrompt)

  return parseJson(raw, {
    suggestions: availableSlots.slice(0, 3),
    parsedIntent: naturalLanguageInput,
  })
}

// ─── Cancellation Intent Detection ───────────────────────────────────────────

export async function detectCancellationIntent(
  message: string
): Promise<{ wantsCancellation: boolean; wantsReschedule: boolean }> {
  const systemPrompt = `You are an intent detection assistant.
Respond ONLY with valid JSON. No markdown, no explanation.`

  const prompt = `Does this message indicate the person wants to cancel or reschedule their appointment?

Message: "${message}"

Return JSON with:
- wantsCancellation: boolean
- wantsReschedule: boolean`

  const raw = await callAi(prompt, systemPrompt)

  return parseJson(raw, { wantsCancellation: false, wantsReschedule: false })
}
