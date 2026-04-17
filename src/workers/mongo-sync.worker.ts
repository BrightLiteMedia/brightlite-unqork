import 'dotenv/config'
import Redis from 'ioredis'
import { config } from '../config'
import { MongoDbAdapter } from '../adapters/mongodb.adapter'
import { Appointment, ClientConfig, ContactSubmission, OtpRecord } from '../types'

type StreamMessage = [string, [string, string[]][]][]
type QueueEntity = 'otp' | 'submission' | 'appointment' | 'client'

async function main() {
  if (!config.db.redisUrl) {
    throw new Error('REDIS_URL must be set to run the Mongo sync worker')
  }

  const redis = new Redis(config.db.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  })
  const mongo = new MongoDbAdapter()
  const stream = config.db.redisWriteStream
  const group = process.env.REDIS_CONSUMER_GROUP ?? 'mongo-sync'
  const consumer = process.env.REDIS_CONSUMER_NAME ?? `mongo-sync-${process.pid}`

  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
      throw error
    }
  }

  console.log(`Mongo sync worker listening on stream "${stream}" as ${group}/${consumer}`)

  while (true) {
    const response = await redis.call(
      'XREADGROUP',
      'GROUP',
      group,
      consumer,
      'BLOCK',
      '5000',
      'COUNT',
      '20',
      'STREAMS',
      stream,
      '>'
    ) as StreamMessage | null

    if (!response) continue

    for (const [, messages] of response) {
      for (const [messageId, rawFields] of messages) {
        const fields = new Map<string, string>()
        for (let i = 0; i < rawFields.length; i += 2) {
          fields.set(rawFields[i], rawFields[i + 1])
        }

        const entity = fields.get('entity') as QueueEntity | undefined
        const payload = fields.get('payload')
        if (!entity || !payload) {
          console.error(`Skipping malformed queue message ${messageId}`)
          await redis.xack(stream, group, messageId)
          continue
        }

        try {
          switch (entity) {
            case 'otp':
              await mongo.saveOtp(JSON.parse(payload) as OtpRecord)
              break
            case 'submission':
              await mongo.saveSubmission(JSON.parse(payload) as ContactSubmission)
              break
            case 'appointment':
              await mongo.saveAppointment(JSON.parse(payload) as Appointment)
              break
            case 'client':
              await mongo.saveClientConfig(JSON.parse(payload) as ClientConfig)
              break
          }

          await redis.xack(stream, group, messageId)
        } catch (error) {
          console.error(`Failed processing message ${messageId}`, error)
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('Mongo sync worker failed to start', error)
  process.exit(1)
})
