// src/utils/scheduling.ts
// Pure utility functions for slot generation and availability logic.
// All functions accept explicit SchedulingConfig so they work for any client
// without depending on the global config singleton.

import { SchedulingConfig, TimeSlot, SmartScheduleSuggestion } from '../types'
import { getDbAdapter } from '../adapters'

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

function formatSlotLabel(date: string, time: string): string {
  const dt = new Date(`${date}T${time}`)
  return dt.toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function generateDaysFromNow(days: number, schedulingConfig: SchedulingConfig): string[] {
  const dates: string[] = []
  const today = new Date()
  for (let i = 1; i <= days; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    const dayOfWeek = d.getDay()
    if (schedulingConfig.availableDays.includes(dayOfWeek)) {
      dates.push(d.toISOString().split('T')[0])
    }
  }
  return dates
}

export async function getAvailableSlotsForDate(
  date: string,
  durationMinutes: number,
  schedulingConfig: SchedulingConfig,
  clientId?: string
): Promise<TimeSlot[]> {
  const db = getDbAdapter()
  const booked = await db.getBookedSlots(date, clientId)

  const startMinutes = timeToMinutes(schedulingConfig.startTime)
  const endMinutes   = timeToMinutes(schedulingConfig.endTime)
  const interval     = schedulingConfig.slotIntervalMinutes

  const slots: TimeSlot[] = []

  for (
    let current = startMinutes;
    current + durationMinutes <= endMinutes;
    current += interval
  ) {
    const time          = minutesToTime(current)
    const slotEndMinutes = current + durationMinutes

    const isBooked = booked.some((b) => {
      const bookedStart = timeToMinutes(b.time)
      const bookedEnd   = bookedStart + b.durationMinutes
      return current < bookedEnd && slotEndMinutes > bookedStart
    })

    slots.push({ date, time, available: !isBooked })
  }

  return slots
}

export async function getAvailableSuggestionsForSmartSchedule(
  lookaheadDays = 14,
  durationMinutes = 30,
  schedulingConfig: SchedulingConfig,
  clientId?: string
): Promise<SmartScheduleSuggestion[]> {
  const dates       = generateDaysFromNow(lookaheadDays, schedulingConfig)
  const suggestions: SmartScheduleSuggestion[] = []

  for (const date of dates) {
    const slots = await getAvailableSlotsForDate(date, durationMinutes, schedulingConfig, clientId)
    for (const slot of slots) {
      if (slot.available) {
        suggestions.push({ date: slot.date, time: slot.time, label: formatSlotLabel(slot.date, slot.time) })
      }
    }
    if (suggestions.length >= 50) break
  }

  return suggestions
}

export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1)
  const d2 = new Date(date2)
  return Math.round(Math.abs((d2.getTime() - d1.getTime()) / 86400000))
}

export function generateConfirmationCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}
