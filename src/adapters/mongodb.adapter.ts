import { Collection, Document, Filter, MongoClient, ServerApiVersion } from 'mongodb'
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

/**
 * this helper takes a mongodb document, removes `_id`, and gives back the rest of the fields.
 *
 * quick breakdown:
 * - `t` is a generic type, which means this function can work with different document shapes.
 * - `t extends document` means `t` has to be an object type mongodb can treat like a document.
 * - `doc` is the function parameter, so this is the actual document being passed in.
 * - `(t & { _id?: unknown })` means the input should look like `t`, but it may also include `_id`.
 * - `_id?: unknown` makes `_id` optional, and `unknown` says we do not care what type `_id` is
 *   because this function never uses it, it only removes it.
 * - `| null` means the function also accepts `null`, which is useful when a lookup did not find anything.
 * - `if (!doc) return null` exits early if there is no document.
 * - `const { _id: _omit, ...rest } = doc` pulls `_id` out of the object and puts everything else into `rest`.
 * - `_id: _omit` is just a way to say "grab `_id`, but do not keep it in the returned object".
 * - `...rest` means "all the other properties that are left".
 * - `rest as unknown as t` tells typescript to trust that once `_id` is removed, the remaining shape
 *   should be treated as `t`, even though typescript cannot fully prove that on its own.
 */
function withoutMongoId<T extends Document>(doc: (T & { _id?: unknown }) | null): T | null {
  if (!doc) return null
  const { _id: _omit, ...rest } = doc
  return rest as unknown as T
}

function toClientConfigPublic(configRecord: ClientConfig): ClientConfigPublic {
  const { apiKeyHash: _omit, ...safe } = configRecord
  return safe
}

function hasDatabaseInMongoUrl(uri: string): boolean {
  try {
    const pathname = new URL(uri).pathname
    return pathname.length > 1
  } catch {
    return false
  }
}

export class MongoDbAdapter implements DbAdapter {
  private readonly client: MongoClient
  private readonly ready: Promise<void>
  private readonly readPreference: 'primary' | 'secondary' | 'secondaryPreferred'

  constructor() {
    if (!config.db.mongoUrl) {
      throw new Error('MONGO_URL must be set when DB_ADAPTER=mongodb')
    }
    if (!config.db.mongoDbName && !hasDatabaseInMongoUrl(config.db.mongoUrl)) {
      throw new Error('Set MONGO_DB_NAME or include a database name in MONGO_URL when DB_ADAPTER=mongodb')
    }

    this.client = new MongoClient(config.db.mongoUrl, {
      ignoreUndefined: true,
      maxPoolSize: 30,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    })
    this.readPreference = this.resolveReadPreference(config.db.mongoReadPreference)
    this.ready = this.initialize()
  }

  private resolveReadPreference(value: string): 'primary' | 'secondary' | 'secondaryPreferred' {
    switch (value) {
      case 'primary':
        return 'primary'
      case 'secondary':
        return 'secondary'
      case 'secondaryPreferred':
      default:
        return 'secondaryPreferred'
    }
  }

  private db() {
    return config.db.mongoDbName
      ? this.client.db(config.db.mongoDbName)
      : this.client.db()
  }

  private otpCollection(): Collection<OtpRecord> {
    return this.db().collection<OtpRecord>('otp_tokens')
  }

  private submissionCollection(): Collection<ContactSubmission> {
    return this.db().collection<ContactSubmission>('contact_submissions')
  }

  private appointmentCollection(): Collection<Appointment> {
    return this.db().collection<Appointment>('appointments')
  }

  private clientCollection(): Collection<ClientConfig> {
    return this.db().collection<ClientConfig>('client_configs')
  }

  private async initialize(): Promise<void> {
    await this.client.connect()

    await Promise.all([
      this.otpCollection().createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { clientId: 1, createdAt: -1 } },
        { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ]),
      this.submissionCollection().createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { clientId: 1, status: 1, submittedAt: -1 } },
      ]),
      this.appointmentCollection().createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { clientId: 1, date: 1, status: 1 } },
      ]),
      this.clientCollection().createIndexes([
        { key: { clientId: 1 }, unique: true },
        { key: { apiKeyHash: 1 }, unique: true },
      ]),
    ])
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  /**
   * this helper asks mongodb atlas search, "how many documents match this search?"
   * without pulling back the actual documents. that matters because the list methods
   * need a real `total` for pagination, but the main `$search` query is only for getting the rows.
   *
   * quick breakdown:
   * - `private` means this helper is only meant to be used inside this adapter class.
   * - `async` means the function does database work and returns later, after mongodb responds.
   * - `<T extends Document>` is a generic. it lets this one helper work with different collection shapes,
   *   as long as each shape is still a mongodb `Document`.
   * - `collection: Collection<T>` is the actual mongodb collection to run the search against.
   *   using `Collection<T>` helps typescript remember what kind of records live in that collection.
   * - `index: string` is the atlas search index name. atlas search needs this so it knows which
   *   search configuration to use.
   * - `compound: Record<string, unknown>` is the search rules object that was built earlier.
   *   it can contain things like `should`, `filter`, and `minimumShouldMatch`.
   *   we pass the same `compound` object used by the real `$search` query so the count matches the data query.
   * - `Promise<number>` means callers eventually get one number back: the total count of matches.
   * - `collection.aggregate(...)` runs a mongodb aggregation pipeline.
   * - `$searchMeta` is like `$search`, but for search metadata instead of search results.
   *   in other words, `$search` returns matching documents, while `$searchMeta` returns information
   *   about the search itself. here we use it because we only want the count.
   * - `index` inside `$searchMeta` tells atlas which search index to use for this count query.
   * - `compound` inside `$searchMeta` reuses the same search logic, so we do not accidentally count
   *   a different set of documents than the ones shown to the user.
   * - `count: { type: 'total' }` tells atlas search to calculate the full number of matches.
   *   this is why `searchMeta` is useful here: it gives us the total without fetching every document.
   * - `{ readPreference: this.readPreference }` tells mongodb which replica it is allowed to read from.
   * - `meta` is just the variable holding the metadata result array that comes back from mongodb.
   * - `(meta[0] as { count?: { total?: number } } | undefined)` is a typescript hint.
   *   typescript cannot automatically see the exact shape returned by this pipeline, so we tell it
   *   that the first result may have a nested `count.total`.
   * - `?.` is optional chaining. it safely reads `count` and `total` without crashing if one piece is missing.
   * - `?? 0` means "use 0 if the left side is `null` or `undefined`".
   * - `Number(...)` makes sure the final return value is a plain javascript number.
   */
  private async getSearchCount<T extends Document>(
    collection: Collection<T>,
    index: string,
    compound: Record<string, unknown>
  ): Promise<number> {
    const meta = await collection.aggregate(
      [
        {
          $searchMeta: {
            index,
            compound,
            count: { type: 'total' },
          },
        },
      ],
      { readPreference: this.readPreference }
    ).toArray()

    return Number((meta[0] as { count?: { total?: number } } | undefined)?.count?.total ?? 0)
  }

  async saveOtp(record: OtpRecord): Promise<void> {
    await this.ready
    await this.otpCollection().updateOne(
      { id: record.id },
      { $set: record },
      { upsert: true }
    )
  }

  async getOtp(tokenId: string): Promise<OtpRecord | null> {
    await this.ready
    return withoutMongoId(
      await this.otpCollection().findOne({ id: tokenId }, { readPreference: this.readPreference })
    )
  }

  async markOtpUsed(tokenId: string): Promise<void> {
    await this.ready
    await this.otpCollection().updateOne({ id: tokenId }, { $set: { used: true } })
  }

  async saveSubmission(submission: ContactSubmission): Promise<void> {
    await this.ready
    await this.submissionCollection().updateOne(
      { id: submission.id },
      { $set: submission },
      { upsert: true }
    )
  }

  async getSubmissions(filters?: SubmissionFilters): Promise<ListResult<ContactSubmission>> {
    await this.ready

    if (filters?.search) {
      const compound: Record<string, unknown> = {
        should: [
          {
            text: {
              query: filters.search,
              path: ['name', 'email', 'phone', 'message', 'routedTo'],
            },
          },
        ],
        minimumShouldMatch: 1,
      }

      const searchFilters: Record<string, unknown>[] = []
      if (filters.clientId) {
        searchFilters.push({ equals: { path: 'clientId', value: filters.clientId } })
      }
      if (filters.status) {
        searchFilters.push({ equals: { path: 'status', value: filters.status } })
      }
      if (filters.category) {
        searchFilters.push({ equals: { path: 'category', value: filters.category } })
      }
      if (searchFilters.length > 0) {
        compound.filter = searchFilters
      }

      const [data, total] = await Promise.all([
        this.submissionCollection().aggregate<ContactSubmission>(
          [
            { $search: { index: config.db.mongoSearchIndexes.submissions, compound } },
            { $sort: { submittedAt: -1 } },
          ],
          { readPreference: this.readPreference }
        ).toArray(),
        this.getSearchCount(
          this.submissionCollection(),
          config.db.mongoSearchIndexes.submissions,
          compound
        ),
      ])

      return {
        data: data.map((doc) => withoutMongoId(doc)!).filter(Boolean),
        total,
      }
    }

    const query: Filter<ContactSubmission> = {}
    if (filters?.clientId) query.clientId = filters.clientId
    if (filters?.status) query.status = filters.status
    if (filters?.category) query.category = filters.category

    const [data, total] = await Promise.all([
      this.submissionCollection().find(query, {
        sort: { submittedAt: -1 },
        readPreference: this.readPreference,
      }).toArray(),
      this.submissionCollection().countDocuments(query),
    ])

    return {
      data: data.map((doc) => withoutMongoId(doc)!).filter(Boolean),
      total,
    }
  }

  async getSubmission(id: string): Promise<ContactSubmission | null> {
    await this.ready
    return withoutMongoId(
      await this.submissionCollection().findOne({ id }, { readPreference: this.readPreference })
    )
  }

  async updateSubmission(id: string, updates: Partial<ContactSubmission>): Promise<void> {
    await this.ready
    await this.submissionCollection().updateOne({ id }, { $set: updates })
  }

  /**
   * this stores one appointment using its `id` as the stable key.
   *
   * quick breakdown:
   * - `appointment: Appointment` means the caller is expected to pass a full appointment object.
   * - `Promise<void>` means this does async database work but does not return a value.
   * - `await this.ready` makes sure the mongo connection is ready before we write.
   * - `{ id: appointment.id }` is the match rule, so mongodb knows which record to update.
   * - `{ $set: appointment }` says "write these fields onto the document".
   * - `{ upsert: true }` means create the document if it does not exist yet, or update it if it already does.
   */
  async saveAppointment(appointment: Appointment): Promise<void> {
    await this.ready
    await this.appointmentCollection().updateOne(
      { id: appointment.id },
      { $set: appointment },
      { upsert: true }
    )
  }

  /**
   * this gets appointments in a list-friendly shape where `data` is the current rows
   * and `total` is the full number of matches.
   *
   * quick breakdown:
   * - `filters?: AppointmentFilters` means the caller can pass no filters at all, or pass an object to narrow the list.
   * - the `?` on `filters` makes that whole parameter optional.
   * - `Promise<ListResult<Appointment>>` means this is async and eventually returns `{ data, total }`.
   * - `await this.ready` makes sure the mongo connection is ready before we query.
   * - `filters?.search` uses optional chaining. if there is a search term, we use atlas search. if not, we use a normal mongodb filter.
   * - `compound: Record<string, unknown>` is the atlas search rules object. it is typed loosely because we build it step by step and it holds nested search config.
   * - `should` is the part of the atlas search query that says "these are the text matches we care about".
   * - `text.query` is the raw search text from the user.
   * - `path` lists which appointment fields atlas search should look through.
   * - `minimumShouldMatch: 1` means at least one `should` rule has to match.
   * - `searchFilters: Record<string, unknown>[]` is a list of exact-match rules for `clientId`, `status`, and `date`.
   * - each `equals` filter is there so the text search stays scoped to the right tenant or date/status subset.
   * - `compound.filter = searchFilters` adds those exact filters on top of the text search.
   * - `Promise.all` runs the row query and the total-count query at the same time, which is faster.
   * - the `$search` pipeline gets the actual appointment rows.
   * - `this.getSearchCount(...)` runs the same `compound` rules through `$searchMeta`.
   * - `$searchMeta` is atlas search's metadata stage. we use it because it tells us the full count of matches without returning every document, which is what pagination needs.
   * - in the non-search branch, `query: Filter<Appointment>` is the normal mongodb filter object for this collection.
   * - both branches sort by `date` and `time` so appointments come back in schedule order.
   * - both branches remove mongo's `_id` before returning because the app uses its own `id` field, not mongodb internals.
   */
  async getAppointments(filters?: AppointmentFilters): Promise<ListResult<Appointment>> {
    await this.ready

    if (filters?.search) {
      const compound: Record<string, unknown> = {
        should: [
          {
            text: {
              query: filters.search,
              path: ['name', 'email', 'phone', 'serviceLabel', 'confirmationCode', 'notes'],
            },
          },
        ],
        minimumShouldMatch: 1,
      }

      const searchFilters: Record<string, unknown>[] = []
      if (filters.clientId) {
        searchFilters.push({ equals: { path: 'clientId', value: filters.clientId } })
      }
      if (filters.status) {
        searchFilters.push({ equals: { path: 'status', value: filters.status } })
      }
      if (filters.date) {
        searchFilters.push({ equals: { path: 'date', value: filters.date } })
      }
      if (searchFilters.length > 0) {
        compound.filter = searchFilters
      }

      const [data, total] = await Promise.all([
        this.appointmentCollection().aggregate<Appointment>(
          [
            { $search: { index: config.db.mongoSearchIndexes.appointments, compound } },
            { $sort: { date: 1, time: 1 } },
          ],
          { readPreference: this.readPreference }
        ).toArray(),
        this.getSearchCount(
          this.appointmentCollection(),
          config.db.mongoSearchIndexes.appointments,
          compound
        ),
      ])

      return {
        data: data.map((doc) => withoutMongoId(doc)!).filter(Boolean),
        total,
      }
    }

    const query: Filter<Appointment> = {}
    if (filters?.clientId) query.clientId = filters.clientId
    if (filters?.date) query.date = filters.date
    if (filters?.status) query.status = filters.status

    const [data, total] = await Promise.all([
      this.appointmentCollection().find(query, {
        sort: { date: 1, time: 1 },
        readPreference: this.readPreference,
      }).toArray(),
      this.appointmentCollection().countDocuments(query),
    ])

    return {
      data: data.map((doc) => withoutMongoId(doc)!).filter(Boolean),
      total,
    }
  }

  /**
   * this fetches one appointment by `id`.
   *
   * quick breakdown:
   * - `id: string` is the appointment id we want to look up.
   * - `Promise<Appointment | null>` means we either get one appointment back or `null` if nothing matched.
   * - `findOne({ id })` is the mongodb lookup.
   * - `withoutMongoId(...)` removes mongo's internal `_id` so the rest of the app gets the shape it expects.
   */
  async getAppointment(id: string): Promise<Appointment | null> {
    await this.ready
    return withoutMongoId(
      await this.appointmentCollection().findOne({ id }, { readPreference: this.readPreference })
    )
  }

  /**
   * this updates only the appointment fields we want to change.
   *
   * quick breakdown:
   * - `id: string` tells mongodb which appointment to update.
   * - `updates: Partial<Appointment>` means the caller can send just the changed fields instead of a full appointment object.
   * - `Partial<Appointment>` is useful here because update calls usually only know about a few fields.
   * - `Promise<void>` means the work is async but there is no data returned.
   * - `...updates` spreads the changed fields into the `$set` object.
   * - `updatedAt: new Date()` is added here so every update leaves a fresh timestamp.
   */
  async updateAppointment(id: string, updates: Partial<Appointment>): Promise<void> {
    await this.ready
    await this.appointmentCollection().updateOne(
      { id },
      { $set: { ...updates, updatedAt: new Date() } }
    )
  }

  /**
   * this returns only the time slots that are already taken for a day.
   *
   * quick breakdown:
   * - `date: string` is the day we are checking.
   * - `clientId?: string` is optional because sometimes we want booked slots for one tenant, and sometimes we may not need that extra filter.
   * - `Promise<{ time: string; durationMinutes: number }[]>` means we get back an array of small objects, not full appointments.
   * - `query: Filter<Appointment>` is the mongodb filter for the lookup.
   * - `status: { $ne: 'cancelled' }` means "ignore cancelled appointments" because cancelled slots should not block availability.
   * - `as any` is a typescript escape hatch here. it tells the compiler to accept this mongo operator shape even though the type inference is being picky.
   * - `projection` keeps only `time` and `durationMinutes`, which is all the scheduling code needs.
   * - `_id: 0` inside `projection` explicitly leaves mongo's internal id out of the result.
   * - the final `map(...)` turns the mongo result into the exact lightweight shape this method promises to return.
   */
  async getBookedSlots(date: string, clientId?: string): Promise<{ time: string; durationMinutes: number }[]> {
    await this.ready

    const query: Filter<Appointment> = {
      date,
      status: { $ne: 'cancelled' } as any,
    }
    if (clientId) query.clientId = clientId

    const appointments = await this.appointmentCollection().find(query, {
      projection: { _id: 0, time: 1, durationMinutes: 1 },
      sort: { time: 1 },
      readPreference: this.readPreference,
    }).toArray()

    return appointments.map((appointment) => ({
      time: appointment.time,
      durationMinutes: appointment.durationMinutes,
    }))
  }

  async saveClientConfig(configRecord: ClientConfig): Promise<void> {
    await this.ready
    await this.clientCollection().updateOne(
      { clientId: configRecord.clientId },
      { $set: configRecord },
      { upsert: true }
    )
  }

  async getClientConfig(clientId: string): Promise<ClientConfig | null> {
    await this.ready
    return withoutMongoId(
      await this.clientCollection().findOne(
        { clientId },
        { readPreference: this.readPreference }
      )
    )
  }

  async getClientConfigByApiKeyHash(apiKeyHash: string): Promise<ClientConfig | null> {
    await this.ready
    return withoutMongoId(
      await this.clientCollection().findOne(
        { apiKeyHash },
        { readPreference: this.readPreference }
      )
    )
  }

  async updateClientConfig(clientId: string, updates: Partial<ClientConfig>): Promise<void> {
    await this.ready
    await this.clientCollection().updateOne(
      { clientId },
      { $set: { ...updates, updatedAt: new Date() } }
    )
  }

  async listClientConfigs(filters?: ClientConfigFilters): Promise<ListResult<ClientConfigPublic>> {
    await this.ready

    if (filters?.search) {
      const compound: Record<string, unknown> = {
        should: [
          {
            text: {
              query: filters.search,
              path: ['name', 'emailFrom', 'emailFromName', 'routing.sales', 'routing.support'],
            },
          },
        ],
        minimumShouldMatch: 1,
      }

      const [data, total] = await Promise.all([
        this.clientCollection().aggregate<ClientConfig>(
          [
            { $search: { index: config.db.mongoSearchIndexes.clients, compound } },
            { $sort: { name: 1 } },
          ],
          { readPreference: this.readPreference }
        ).toArray(),
        this.getSearchCount(
          this.clientCollection(),
          config.db.mongoSearchIndexes.clients,
          compound
        ),
      ])

      return {
        data: data
          .map((doc) => withoutMongoId(doc))
          .filter(Boolean)
          .map((client) => toClientConfigPublic(client!)),
        total,
      }
    }

    const clients = await this.clientCollection().find(
      {},
      {
        sort: { name: 1 },
        readPreference: this.readPreference,
      }
    ).toArray()

    return {
      data: clients
        .map((doc) => withoutMongoId(doc))
        .filter(Boolean)
        .map((client) => toClientConfigPublic(client!)),
      total: clients.length,
    }
  }
}
