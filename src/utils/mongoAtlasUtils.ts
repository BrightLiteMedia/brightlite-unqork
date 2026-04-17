import { createHash } from 'crypto'
import OpenAI from 'openai'
import { Filter, MongoClient, ObjectId } from 'mongodb'
import { config } from '../config'

type LotStatus = 'available' | 'reserved' | 'contracted' | 'construction' | 'closed' | 'cancelled'

interface LotSearchParams {
  tenantId: string
  communityId?: string
  status?: string[]
  searchTerm?: string
  minPrice?: number
  maxPrice?: number
  page?: number
  pageSize?: number
}

interface FacetBucket {
  _id: string
  count: number
}

interface PriceBucket {
  _id: string
  count: number
}

interface LotSearchResponse {
  results: SimilarLotMatch[]
  totalCount: number
  totalPages: number
  statusCounts: FacetBucket[]
  agentCounts: FacetBucket[]
  priceBuckets: PriceBucket[]
}

interface LotSearchMetadata {
  planDocument?: string
  planEmbedding?: number[]
  planEmbeddingModel?: string
  planEmbeddedAt?: Date
}

interface LotDocument {
  _id?: ObjectId
  tenantId: string
  communityId: ObjectId | string
  communityName?: string
  lotNumber?: string
  address?: string
  status?: LotStatus | string
  pricing?: {
    basePrice?: number
    lotPremium?: number
    optionsTotal?: number
    contractPrice?: number
  }
  buyers?: Array<{
    type?: 'primary' | 'co-buyer'
    firstName?: string
    lastName?: string
    email?: string
    loanType?: 'conventional' | 'FHA' | 'VA' | 'cash' | string
  }>
  construction?: {
    currentStage?: string
    pctComplete?: number
  }
  agentName?: string
  search?: LotSearchMetadata
  createdAt?: Date
  updatedAt?: Date
  [key: string]: unknown
}

interface CommunityDocument {
  _id?: ObjectId
  tenantId: string
  name: string
  city?: string
  state?: string
  status?: string
  priceRange?: { min?: number; max?: number }
}

interface EmbeddingResult {
  embedding: number[]
  model: string
}

interface EnsureLotPlanEmbeddingParams {
  lotId?: string
  lot?: LotDocument
  community?: CommunityDocument | null
}

interface EnsureLotPlanEmbeddingResult {
  lot: LotDocument
  planDocument: string
  embedding: number[]
  model: string
  source: 'existing' | 'generated'
}

export interface SimilarLotSearchParams {
  referenceLotId: string
  limit?: number
  numCandidates?: number
  excludeSameCommunity?: boolean
  allowedStatuses?: string[]
  minPrice?: number
  maxPrice?: number
}

export interface SimilarLotMatch {
  id: string
  communityId: string
  communityName?: string
  communityCity?: string
  communityState?: string
  lotNumber?: string
  address?: string
  status?: string
  agentName?: string
  basePrice?: number
  contractPrice?: number
  searchScore?: number
  vectorScore?: number
  planDocument?: string
  searchHighlights?: unknown[]
}

export interface SimilarLotSearchResponse {
  referenceLot: SimilarLotMatch
  matches: SimilarLotMatch[]
}

export interface BackfillLotPlanEmbeddingsParams {
  tenantId?: string
  batchSize?: number
  limit?: number
  onlyMissing?: boolean
}

export interface BackfillLotPlanEmbeddingsResult {
  scanned: number
  updated: number
  skipped: number
}

const PRICE_LABELS: Record<string | number, string> = {
  0: 'Under $300k',
  300_000: '$300k-$400k',
  400_000: '$400k-$500k',
  500_000: '$500k-$600k',
  600_000: '$600k-$750k',
  750_000: '$750k-$1M',
  1_000_000: 'Over $1M',
  other: 'Over $1M',
}

const DEFAULT_SIMILAR_STATUSES = ['available', 'reserved', 'contracted', 'construction']
const DEFAULT_SIMILAR_LIMIT = 8
const DEFAULT_NUM_CANDIDATES_MULTIPLIER = 8

export const LOT_PLAN_VECTOR_INDEX_DEFINITION = {
  fields: [
    {
      type: 'vector',
      path: 'search.planEmbedding',
      numDimensions: config.embeddings.dimensions,
      similarity: 'cosine',
    },
    { type: 'filter', path: 'tenantId' },
    { type: 'filter', path: 'communityId' },
    { type: 'filter', path: 'status' },
    { type: 'filter', path: 'pricing.basePrice' },
  ],
} as const

let mongoClient: MongoClient | null = null
let openAiClient: OpenAI | null = null

function getMongoClient(): MongoClient {
  if (!mongoClient) {
    if (!config.lotSearch.mongoUrl) {
      throw new Error('Set LOT_VECTOR_MONGO_URL, MONGO_URL, or MONGODB_URI before using lot Atlas utilities')
    }

    mongoClient = new MongoClient(config.lotSearch.mongoUrl, {
      ignoreUndefined: true,
      maxPoolSize: 10,
    })
  }

  return mongoClient
}

async function getDb() {
  const client = getMongoClient()
  await client.connect()
  return client.db(config.lotSearch.mongoDbName)
}

export async function closeLotSearchMongoClient(): Promise<void> {
  if (!mongoClient) return
  const client = mongoClient
  mongoClient = null
  await client.close()
}

function getOpenAiClient(): OpenAI {
  if (!config.ai.openaiApiKey) {
    throw new Error('OPENAI_API_KEY must be set when EMBEDDING_PROVIDER=openai')
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  return openAiClient
}

function toIdString(value: unknown): string {
  if (value instanceof ObjectId) return value.toHexString()
  return String(value ?? '')
}

function toObjectId(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  return null
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getNestedValue(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, record)
}

function pickFirstString(record: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getNestedValue(record, path)
    if (typeof value === 'string' && normalizeWhitespace(value)) {
      return normalizeWhitespace(value)
    }
  }

  return undefined
}

function pickFirstNumber(record: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = getNestedValue(record, path)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  return undefined
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function getPriceBand(value?: number): string | undefined {
  if (value === undefined) return undefined
  if (value < 300_000) return 'Under $300k'
  if (value < 400_000) return '$300k-$400k'
  if (value < 500_000) return '$400k-$500k'
  if (value < 600_000) return '$500k-$600k'
  if (value < 750_000) return '$600k-$750k'
  if (value < 1_000_000) return '$750k-$1M'
  return 'Over $1M'
}

function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!magnitude) return values
  return values.map((value) => value / magnitude)
}

function buildMockEmbedding(input: string, dimensions: number): number[] {
  const tokens = normalizeWhitespace(input).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const vector = new Array(dimensions).fill(0)

  for (const token of tokens) {
    const hash = createHash('sha256').update(token).digest()
    for (let i = 0; i < hash.length; i += 4) {
      const slot = hash[i] % dimensions
      const sign = hash[i + 1] % 2 === 0 ? 1 : -1
      const weight = (hash[i + 2] / 255) + (hash[i + 3] / 1024)
      vector[slot] += sign * weight
    }
  }

  return normalizeVector(vector)
}

async function generateEmbedding(input: string): Promise<EmbeddingResult> {
  if (config.embeddings.provider === 'mock') {
    return {
      embedding: buildMockEmbedding(input, config.embeddings.dimensions),
      model: `mock:${config.embeddings.dimensions}`,
    }
  }

  const client = getOpenAiClient()
  const request: {
    model: string
    input: string
    dimensions?: number
  } = {
    model: config.embeddings.openaiModel,
    input,
  }

  if (config.embeddings.openaiModel.startsWith('text-embedding-3')) {
    request.dimensions = config.embeddings.dimensions
  }

  const response = await client.embeddings.create(request)
  const vector = response.data[0]?.embedding
  if (!vector) {
    throw new Error('Embedding provider returned no vector data')
  }

  return {
    embedding: normalizeVector(vector),
    model: `openai:${config.embeddings.openaiModel}:${vector.length}`,
  }
}

async function loadCommunityMap(communityIds: string[]): Promise<Map<string, CommunityDocument>> {
  const ids = communityIds.map((value) => toObjectId(value)).filter((value): value is ObjectId => Boolean(value))
  if (ids.length === 0) return new Map()

  const db = await getDb()
  const communities = await db.collection<CommunityDocument>('communities')
    .find({ _id: { $in: ids } })
    .toArray()

  return new Map(communities.map((community) => [community._id!.toHexString(), community]))
}

async function loadLotById(lotId: string): Promise<LotDocument | null> {
  const db = await getDb()
  const collection = db.collection<LotDocument>('lots')
  return collection.findOne({ _id: new ObjectId(lotId) })
}

function shapeLotMatch(lot: LotDocument, community?: CommunityDocument | null): SimilarLotMatch {
  return {
    id: toIdString(lot._id),
    communityId: toIdString(lot.communityId),
    communityName: lot.communityName ?? community?.name,
    communityCity: community?.city,
    communityState: community?.state,
    lotNumber: lot.lotNumber,
    address: lot.address,
    status: typeof lot.status === 'string' ? lot.status : undefined,
    agentName: lot.agentName,
    basePrice: lot.pricing?.basePrice,
    contractPrice: lot.pricing?.contractPrice,
    planDocument: lot.search?.planDocument,
  }
}

export function buildLotPlanDocument(lot: LotDocument, community?: CommunityDocument | null): string {
  const record = lot as Record<string, unknown>

  const planName = pickFirstString(record, [
    'plan.name',
    'plan.label',
    'planName',
    'planLabel',
    'floorPlanName',
    'floorplanName',
    'model.name',
    'modelName',
  ])
  const planCode = pickFirstString(record, ['plan.code', 'planCode', 'model.code', 'modelCode'])
  const elevation = pickFirstString(record, ['plan.elevation', 'elevation'])
  const beds = pickFirstNumber(record, ['plan.bedrooms', 'bedrooms', 'beds'])
  const baths = pickFirstNumber(record, ['plan.bathrooms', 'bathrooms', 'baths'])
  const halfBaths = pickFirstNumber(record, ['plan.halfBathrooms', 'halfBathrooms', 'halfBaths'])
  const stories = pickFirstNumber(record, ['plan.stories', 'stories'])
  const squareFeet = pickFirstNumber(record, ['plan.squareFeet', 'squareFeet', 'sqft', 'sqFt', 'livingArea'])
  const garageSpaces = pickFirstNumber(record, ['plan.garageSpaces', 'garageSpaces'])

  const communityLabel = [
    community?.name ?? lot.communityName,
    community?.city,
    community?.state,
  ].filter(Boolean).join(', ')

  const layoutParts = [
    beds !== undefined ? `${beds} bedrooms` : undefined,
    baths !== undefined ? `${baths} bathrooms` : undefined,
    halfBaths !== undefined ? `${halfBaths} half bathrooms` : undefined,
    stories !== undefined ? `${stories} stories` : undefined,
    squareFeet !== undefined ? `${squareFeet} square feet` : undefined,
    garageSpaces !== undefined ? `${garageSpaces} garage spaces` : undefined,
  ].filter(Boolean)

  const pricingParts = [
    lot.pricing?.basePrice !== undefined ? `base price ${formatCurrency(lot.pricing.basePrice)}` : undefined,
    lot.pricing?.lotPremium !== undefined ? `lot premium ${formatCurrency(lot.pricing.lotPremium)}` : undefined,
    lot.pricing?.optionsTotal !== undefined ? `options ${formatCurrency(lot.pricing.optionsTotal)}` : undefined,
    getPriceBand(lot.pricing?.basePrice),
  ].filter(Boolean)

  return [
    'Lot plan profile',
    planName ? `plan name: ${planName}` : undefined,
    planCode ? `plan code: ${planCode}` : undefined,
    elevation ? `elevation: ${elevation}` : undefined,
    layoutParts.length ? `layout: ${layoutParts.join(', ')}` : undefined,
    communityLabel ? `community: ${communityLabel}` : undefined,
    lot.lotNumber ? `lot number: ${lot.lotNumber}` : undefined,
    lot.address ? `address: ${lot.address}` : undefined,
    typeof lot.status === 'string' ? `status: ${lot.status}` : undefined,
    lot.construction?.currentStage ? `construction stage: ${lot.construction.currentStage}` : undefined,
    pricingParts.length ? `pricing: ${pricingParts.join(', ')}` : undefined,
    lot.agentName ? `sales agent: ${lot.agentName}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeWhitespace)
    .join('\n')
}

function buildTextSearchCompound(params: LotSearchParams) {
  const mustClauses: Record<string, unknown>[] = []
  const filterClauses: Record<string, unknown>[] = [
    {
      equals: {
        path: 'tenantId',
        value: params.tenantId,
      },
    },
  ]

  if (params.communityId) {
    filterClauses.push({
      equals: {
        path: 'communityId',
        value: params.communityId,
      },
    })
  }

  if (params.status?.length) {
    filterClauses.push({
      text: {
        query: params.status,
        path: 'status',
      },
    })
  }

  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    filterClauses.push({
      range: {
        path: 'pricing.basePrice',
        ...(params.minPrice !== undefined && { gte: params.minPrice }),
        ...(params.maxPrice !== undefined && { lte: params.maxPrice }),
      },
    })
  }

  if (params.searchTerm) {
    mustClauses.push({
      text: {
        query: params.searchTerm,
        path: ['buyers.firstName', 'buyers.lastName', 'address'],
        fuzzy: {
          maxEdits: 1,
          prefixLength: 2,
          maxExpansions: 50,
        },
      },
    })
  }

  return {
    compound: {
      filter: filterClauses,
      ...(mustClauses.length ? { must: mustClauses } : {}),
    },
  }
}

async function searchLots_AFTER(params: LotSearchParams): Promise<LotSearchResponse> {
  const db = await getDb()
  const collection = db.collection<LotDocument>('lots')
  const { page = 1, pageSize = 25 } = params
  const compoundOperator = buildTextSearchCompound(params)

  const [results, metaResults] = await Promise.all([
    collection.aggregate(
      [
        {
          $search: {
            index: config.db.mongoSearchIndexes.lots,
            ...compoundOperator,
            count: { type: 'lowerBound' },
            highlight: { path: 'address' },
          },
        },
        {
          $addFields: {
            searchScore: { $meta: 'searchScore' },
            searchHighlights: { $meta: 'searchHighlights' },
          },
        },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            lotNumber: 1,
            address: 1,
            status: 1,
            agentName: 1,
            communityId: 1,
            communityName: 1,
            'pricing.basePrice': 1,
            'pricing.contractPrice': 1,
            'search.planDocument': 1,
            searchScore: 1,
            searchHighlights: 1,
          },
        },
      ] as Record<string, unknown>[]
    ).toArray(),
    collection.aggregate(
      [
        {
          $searchMeta: {
            index: config.db.mongoSearchIndexes.lots,
            facet: {
              operator: compoundOperator,
              facets: {
                statusFacet: {
                  type: 'string',
                  path: 'status',
                  numBuckets: 10,
                },
                agentFacet: {
                  type: 'string',
                  path: 'agentName',
                  numBuckets: 10,
                },
                priceFacet: {
                  type: 'number',
                  path: 'pricing.basePrice',
                  boundaries: [0, 300_000, 400_000, 500_000, 600_000, 750_000, 1_000_000],
                  default: 'other',
                },
              },
            },
          },
        },
      ] as Record<string, unknown>[]
    ).toArray(),
  ])

  const rawResults = results as Array<LotDocument & {
    searchScore?: number
    searchHighlights?: unknown[]
  }>
  const meta = (metaResults[0] ?? {}) as {
    count?: { lowerBound?: number }
    facet?: {
      statusFacet?: { buckets?: Array<{ _id: string; count: number }> }
      agentFacet?: { buckets?: Array<{ _id: string; count: number }> }
      priceFacet?: { buckets?: Array<{ _id: string | number; count: number }> }
    }
  }
  const communityMap = await loadCommunityMap(rawResults.map((lot) => toIdString(lot.communityId)))

  return {
    results: rawResults.map((lot) => ({
      ...shapeLotMatch(lot, communityMap.get(toIdString(lot.communityId)) ?? null),
      searchScore: lot.searchScore,
      searchHighlights: lot.searchHighlights,
    })),
    totalCount: meta.count?.lowerBound ?? 0,
    totalPages: Math.ceil((meta.count?.lowerBound ?? 0) / pageSize),
    statusCounts: (meta.facet?.statusFacet?.buckets ?? []).map((bucket) => ({
      _id: bucket._id,
      count: bucket.count,
    })),
    agentCounts: (meta.facet?.agentFacet?.buckets ?? []).map((bucket) => ({
      _id: bucket._id,
      count: bucket.count,
    })),
    priceBuckets: (meta.facet?.priceFacet?.buckets ?? [])
      .map((bucket) => ({
        _id: PRICE_LABELS[bucket._id] ?? `${bucket._id}`,
        count: bucket.count,
      }))
      .filter((bucket) => bucket.count > 0),
  }
}

export async function ensureLotPlanEmbedding(
  params: EnsureLotPlanEmbeddingParams
): Promise<EnsureLotPlanEmbeddingResult> {
  const db = await getDb()
  const collection = db.collection<LotDocument>('lots')

  const lot = params.lot ?? (params.lotId ? await loadLotById(params.lotId) : null)
  if (!lot || !lot._id) {
    throw new Error('Reference lot not found')
  }

  if (lot.search?.planEmbedding?.length) {
    return {
      lot,
      planDocument: lot.search.planDocument ?? buildLotPlanDocument(lot, params.community ?? null),
      embedding: lot.search.planEmbedding,
      model: lot.search.planEmbeddingModel ?? 'unknown',
      source: 'existing',
    }
  }

  const community = params.community ?? (await loadCommunityMap([toIdString(lot.communityId)])).get(toIdString(lot.communityId)) ?? null
  const planDocument = buildLotPlanDocument(lot, community)
  const { embedding, model } = await generateEmbedding(planDocument)
  const embeddedAt = new Date()

  await collection.updateOne(
    { _id: lot._id },
    {
      $set: {
        'search.planDocument': planDocument,
        'search.planEmbedding': embedding,
        'search.planEmbeddingModel': model,
        'search.planEmbeddedAt': embeddedAt,
      },
    }
  )

  const updatedLot: LotDocument = {
    ...lot,
    search: {
      ...(lot.search ?? {}),
      planDocument,
      planEmbedding: embedding,
      planEmbeddingModel: model,
      planEmbeddedAt: embeddedAt,
    },
  }

  return {
    lot: updatedLot,
    planDocument,
    embedding,
    model,
    source: 'generated',
  }
}

export async function findSimilarLotsByReferenceLot(
  params: SimilarLotSearchParams
): Promise<SimilarLotSearchResponse> {
  const db = await getDb()
  const collection = db.collection<LotDocument>('lots')
  const reference = await ensureLotPlanEmbedding({ lotId: params.referenceLotId })
  const limit = params.limit ?? DEFAULT_SIMILAR_LIMIT
  const requestedStatuses = params.allowedStatuses?.length ? params.allowedStatuses : DEFAULT_SIMILAR_STATUSES
  const rawLimit = Math.max(limit + 6, limit * 2)
  const numCandidates = Math.max(
    params.numCandidates ?? limit * DEFAULT_NUM_CANDIDATES_MULTIPLIER,
    rawLimit
  )

  const vectorFilter: Record<string, unknown> = {
    tenantId: reference.lot.tenantId,
    status: { $in: requestedStatuses },
  }

  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    vectorFilter['pricing.basePrice'] = {
      ...(params.minPrice !== undefined && { $gte: params.minPrice }),
      ...(params.maxPrice !== undefined && { $lte: params.maxPrice }),
    }
  }

  const matches = await collection.aggregate(
    [
      {
        $vectorSearch: {
          index: config.db.mongoSearchIndexes.lotPlanVector,
          path: 'search.planEmbedding',
          queryVector: reference.embedding,
          numCandidates,
          limit: rawLimit,
          filter: vectorFilter,
        },
      },
      {
        $set: {
          vectorScore: { $meta: 'vectorSearchScore' },
        },
      },
      {
        $match: {
          _id: { $ne: reference.lot._id },
          ...(params.excludeSameCommunity !== false
            ? { communityId: { $ne: reference.lot.communityId } }
            : {}),
        },
      },
      { $sort: { vectorScore: -1 } },
      { $limit: limit },
      {
        $project: {
          lotNumber: 1,
          address: 1,
          status: 1,
          agentName: 1,
          communityId: 1,
          communityName: 1,
          pricing: 1,
          search: 1,
          vectorScore: 1,
        },
      },
    ] as Record<string, unknown>[]
  ).toArray() as Array<LotDocument & { vectorScore?: number }>

  const communityIds = [toIdString(reference.lot.communityId), ...matches.map((lot) => toIdString(lot.communityId))]
  const communityMap = await loadCommunityMap(communityIds)

  return {
    referenceLot: shapeLotMatch(
      reference.lot,
      communityMap.get(toIdString(reference.lot.communityId)) ?? null
    ),
    matches: matches.map((lot) => ({
      ...shapeLotMatch(lot, communityMap.get(toIdString(lot.communityId)) ?? null),
      vectorScore: lot.vectorScore,
    })),
  }
}

export async function backfillLotPlanEmbeddings(
  params: BackfillLotPlanEmbeddingsParams = {}
): Promise<BackfillLotPlanEmbeddingsResult> {
  const db = await getDb()
  const collection = db.collection<LotDocument>('lots')
  const batchSize = params.batchSize ?? 25
  const limit = params.limit ?? 100
  const onlyMissing = params.onlyMissing ?? true
  const query: Record<string, unknown> = {}

  if (params.tenantId) {
    query.tenantId = params.tenantId
  }

  if (onlyMissing) {
    query.$or = [
      { 'search.planEmbedding': { $exists: false } },
      { 'search.planEmbedding': null },
    ]
  }

  const lots = await collection.find(
    query as Filter<LotDocument>,
    { sort: { updatedAt: -1 }, limit, batchSize }
  ).toArray()

  let updated = 0
  let skipped = 0
  const communityMap = await loadCommunityMap(lots.map((lot) => toIdString(lot.communityId)))

  for (const lot of lots) {
    if (lot.search?.planEmbedding?.length) {
      skipped += 1
      continue
    }

    await ensureLotPlanEmbedding({
      lot,
      community: communityMap.get(toIdString(lot.communityId)) ?? null,
    })
    updated += 1
  }

  return {
    scanned: lots.length,
    updated,
    skipped,
  }
}

export { searchLots_AFTER }
