/**
 * MongoDB + Atlas — Utils
 * ─────────────────────────────────────────
 * Domain: HomeSalesOne homebuilder platform
 * Collections: lots, communities, agents, option_catalog
 */

import { MongoClient, ObjectId, Filter, Collection, WithId } from "mongodb";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types & connection
// ─────────────────────────────────────────────────────────────────────────────

interface Lot {
    _id?: ObjectId;
    tenantId: string;
    communityId: ObjectId;
    communityName: string;        // extended ref — avoids $lookup on reads
    lotNumber: string;
    address: string;
    status: "available" | "reserved" | "contracted" | "construction" | "closed" | "cancelled";
    pricing: {
        basePrice: number;
        lotPremium: number;
        optionsTotal: number;
        contractPrice: number;
    };
    buyers: Array<{
        type: "primary" | "co-buyer";
        firstName: string;
        lastName: string;
        email: string;
        loanType: "conventional" | "FHA" | "VA" | "cash";
    }>;
    construction: {
        currentStage: string;
        pctComplete: number;
    };
    agentId: ObjectId;
    agentName: string;            // extended ref
    schemaVersion: number;
    createdAt: Date;
    updatedAt: Date;
}

interface Community {
    _id?: ObjectId;
    tenantId: string;
    name: string;
    city: string;
    state: string;
    status: "upcoming" | "active" | "sold_out" | "closed";
    priceRange: { min: number; max: number };
    stats: {
        available: number;
        contracted: number;
        construction: number;
        closed: number;
        totalLots: number;
    };
}

// Singleton MongoClient — one connection pool for the entire app
const client = new MongoClient(process.env.MONGODB_URI!, {
    maxPoolSize: 10,
    minPoolSize: 2,
});

async function getDb() {
    await client.connect();
    return client.db("homebuilder");
}

// ─────────────────────────────────────────────────────────────────────────────
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  List collections then filter within them                   ║
// ║                                                                          ║
// ║  WHY:  A tenant admin lands on the dashboard and needs to know which    ║
// ║        collections exist in their DB (useful for multi-tenant SaaS       ║
// ║        introspection / health check) and then pulls only the active      ║
// ║        communities from the communities collection.                      ║
// ║                                                                          ║
// ║  HOW:  listCollections() issues a single command to the admin database.  ║
// ║        We then narrow to collections that match a naming convention and  ║
// ║        query communities with a compound filter on tenantId + status.    ║
// ║        Index: { tenantId: 1, status: 1 } makes this an IXSCAN.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

interface CollectionSummary {
    name: string;
    type: string;
}

interface ActiveCommunitySummary {
    id: string;
    name: string;
    city: string;
    state: string;
    availableLots: number;
    priceRange: { min: number; max: number };
}

async function listAndFilter(tenantId: string): Promise<{
    collections: CollectionSummary[];
    activeCommunities: ActiveCommunitySummary[];
}> {
    const db = await getDb();

    // ── list all collections in this database ────────────────────────
    // listCollections() returns a cursor over collection metadata objects.
    // We materialise it with toArray() — the collection count is always small.
    // We filter in JS (not MongoDB) because the list is tiny and there is no
    // index to leverage here anyway.
    const allCollections = await db.listCollections().toArray();

    // Keep only "core" domain collections (exclude system and temp collections)
    const coreNames = new Set(["lots", "communities", "agents", "option_catalog"]);
    const collections: CollectionSummary[] = allCollections
        .filter((c) => coreNames.has(c.name))
        .map((c) => ({ name: c.name, type: c.type ?? "collection" }));

    console.log("Collections found:", collections.map((c) => c.name).join(", "));

    // ── filter the communities collection ─────────────────────────────
    // We only want communities for this tenant that are currently active.
    // The $in on status lets us grab both "active" and "upcoming" in one pass
    // rather than two separate queries.
    //
    // Index hit: { tenantId: 1, status: 1 }
    //   → Equality on tenantId, then equality range on status — IXSCAN
    //
    // Projection: we ask only for the fields the dashboard card needs.
    // This avoids pulling the full stats sub-document and other heavy fields.

    const communitiesCol = db.collection<Community>("communities");

    const filter: Filter<Community> = {
        tenantId,
        status: { $in: ["active", "upcoming"] },   // $in over $or — one index scan
    };

    const raw = await communitiesCol
        .find(filter, {
            projection: {
                name: 1,
                city: 1,
                state: 1,
                status: 1,
                priceRange: 1,
                "stats.available": 1,   // partial sub-document projection
            },
        })
        .sort({ "stats.available": -1 }) // most inventory first
        .toArray();

    const activeCommunities: ActiveCommunitySummary[] = raw.map((c) => ({
        id: c._id!.toString(),
        name: c.name,
        city: c.city,
        state: c.state,
        availableLots: c.stats.available,
        priceRange: c.priceRange,
    }));

    return { collections, activeCommunities };
}

// ─────────────────────────────────────────────────────────────────────────────
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Find, filter, and sort inside a collection                 ║
// ║                                                                          ║
// ║  WHY:  A sales agent opens their lot search view. They want to see       ║
// ║        available lots in a specific community, priced between $400K–     ║
// ║        $600K, sorted cheapest-first, with cursor-based pagination so     ║
// ║        the list stays stable as new lots are added.                      ║
// ║                                                                          ║
// ║  HOW:  Cursor pagination using _id as the stable cursor beats skip/limit ║
// ║        at scale — skip(N) still scans N documents internally. With       ║
// ║        cursor pagination, each page is a single bounded IXSCAN.          ║
// ║        Index: { tenantId:1, communityId:1, status:1, "pricing.base":1 } ║
// ╚══════════════════════════════════════════════════════════════════════════╝

interface LotSearchParams {
    tenantId: string;
    communityId: string;
    minPrice?: number;
    maxPrice?: number;
    loanTypes?: Array<"conventional" | "FHA" | "VA" | "cash">;
    afterId?: string;       // cursor: last _id from previous page
    pageSize?: number;
}

interface LotCard {
    id: string;
    lotNumber: string;
    address: string;
    basePrice: number;
    status: string;
    agentName: string;
}

async function findFilterSort(
    params: LotSearchParams
): Promise<{ lots: LotCard[]; nextCursor: string | null }> {
    const db = await getDb();
    const col = db.collection<Lot>("lots");
    const pageSize = params.pageSize ?? 25;

    // ── Build the filter incrementally ───────────────────────────────────────
    // Start with the equality predicates — these drive the IXSCAN selectivity.
    // Equality first, then range ($gte/$lte) — matches the index field order.
    //
    // WHY compound filter instead of separate queries:
    //   One IXSCAN is always faster than two IXSCAN + JS intersection.

    const filter: Filter<Lot> = {
        tenantId: params.tenantId,                    // equality — leading index field
        communityId: new ObjectId(params.communityId),// equality — second index field
        status: "available",                          // equality — third index field
    };

    // Add range predicates only when provided (don't over-constrain)
    if (params.minPrice !== undefined || params.maxPrice !== undefined) {
        filter["pricing.basePrice"] = {
            ...(params.minPrice !== undefined && { $gte: params.minPrice }),
            ...(params.maxPrice !== undefined && { $lte: params.maxPrice }),
        };
    }

    // Filter on buyer loan types — useful for agent-specific searches
    // Uses $elemMatch so BOTH conditions apply to the SAME buyer element
    if (params.loanTypes?.length) {
        filter.buyers = {
            $elemMatch: { loanType: { $in: params.loanTypes } },
        };
    }

    // ── Cursor-based pagination ───────────────────────────────────────────────
    // afterId is the _id of the last document on the previous page.
    // We add { _id: { $gt: afterId } } so MongoDB continues from that point.
    // This works because _id (ObjectId) is always monotonically increasing —
    // it doubles as a stable sort key.
    //
    // WHY not skip/limit:
    //   skip(500) still reads 500 docs to discard them. $gt: lastId reads 0.

    if (params.afterId) {
        filter._id = { $gt: new ObjectId(params.afterId) } as any;
    }

    // ── Execute: sort price ASC, use _id as the tiebreaker ───────────────────
    // A compound sort { price: 1, _id: 1 } is stable — two lots at the same
    // price always appear in the same order. Without _id the tiebreaker is
    // arbitrary and pages can repeat documents.

    const lots = await col
        .find(filter, {
            projection: {
                lotNumber: 1,
                address: 1,
                "pricing.basePrice": 1,
                status: 1,
                agentName: 1,             // already denormalised — no join needed
            },
        })
        .sort({ "pricing.basePrice": 1, _id: 1 })
        .limit(pageSize + 1)          // fetch one extra to detect if more pages exist
        .toArray();

    // If we got pageSize+1 docs, there is a next page
    const hasMore = lots.length > pageSize;
    const page = hasMore ? lots.slice(0, pageSize) : lots;

    const result: LotCard[] = page.map((l) => ({
        id: l._id!.toString(),
        lotNumber: l.lotNumber,
        address: l.address,
        basePrice: l.pricing.basePrice,
        status: l.status,
        agentName: l.agentName,
    }));

    return {
        lots: result,
        nextCursor: hasMore ? page.at(-1)!._id!.toString() : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Repository Facade pattern                                  ║
// ║                                                                          ║
// ║  WHY:  The application has 12 services that all touch the lots           ║
// ║        collection. Scattering raw Collection<Lot> calls across the       ║
// ║        codebase means every service knows about $elemMatch, ObjectId     ║
// ║        conversion, tenant scoping, and index field order. One bug fix    ║
// ║        requires touching 12 files.                                       ║
// ║                                                                          ║
// ║        A Facade (Repository) centralises all query logic. Services       ║
// ║        speak the domain language ("find available lots under $500K"),    ║
// ║        not MongoDB query language. The Facade owns the MongoDB details.  ║
// ║                                                                          ║
// ║  HOW:  A class wraps Collection<Lot>. Every public method enforces       ║
// ║        tenantId scoping automatically — no service can accidentally      ║
// ║        query across tenant boundaries. ObjectId conversion happens once, ║
// ║        in the facade, not scattered across callers.                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

class LotRepository {
    private col: Collection<Lot>;
    private tenantId: string;

    // The repository is always constructed with a tenantId.
    // Every query automatically scopes to this tenant — callers cannot forget.
    constructor(col: Collection<Lot>, tenantId: string) {
        this.col = col;
        this.tenantId = tenantId;
    }

    // ── Private helper: base filter always includes tenantId ─────────────────
    // This is the key safety mechanism. No public method can bypass it.
    private base(extra: Filter<Lot> = {}): Filter<Lot> {
        return { tenantId: this.tenantId, ...extra };
    }

    // ── findById ─────────────────────────────────────────────────────────────
    // WHY: The most common lookup. Single document, exact match on _id.
    // HOW: Primary key lookup — always an IXSCAN on the _id index, O(1).
    async findById(id: string): Promise<Lot | null> {
        return this.col.findOne(
            this.base({ _id: new ObjectId(id) })  // tenantId guard + _id
        );
    }

    // ── findAvailable ─────────────────────────────────────────────────────────
    // WHY: Community listing page — show all purchasable lots with price range.
    // HOW: Compound filter, sorted by price. Index drives the IXSCAN;
    //      the sort field is the last index field so no in-memory sort needed.
    async findAvailable(params: {
        communityId: string;
        maxPrice?: number;
        page?: number;
        pageSize?: number;
    }): Promise<Lot[]> {
        const { page = 1, pageSize = 25 } = params;

        const filter = this.base({
            communityId: new ObjectId(params.communityId),
            status: "available",
            ...(params.maxPrice && { "pricing.basePrice": { $lte: params.maxPrice } }),
        });

        return this.col
            .find(filter)
            .sort({ "pricing.basePrice": 1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .toArray();
    }

    // ── findByBuyerEmail ─────────────────────────────────────────────────────
    // WHY: A buyer calls in — agent needs to pull all their lots immediately.
    // HOW: $elemMatch ensures the email condition matches one buyer element.
    //      Without $elemMatch, two separate buyer emails on two different buyers
    //      could satisfy the query incorrectly.
    async findByBuyerEmail(email: string): Promise<Lot[]> {
        return this.col
            .find(this.base({
                buyers: { $elemMatch: { email: email.toLowerCase() } },
            }))
            .sort({ updatedAt: -1 })
            .limit(10)
            .toArray();
    }

    // ── findInConstruction ────────────────────────────────────────────────────
    // WHY: Construction manager dashboard — show all lots currently being built,
    //      optionally filtered to a specific stage.
    // HOW: Partial index on { status: "construction" } keeps this fast.
    //      Optional stage filter narrows further without a second query.
    async findInConstruction(params: {
        communityId?: string;
        stage?: string;
    } = {}): Promise<Lot[]> {
        const filter = this.base({
            status: "construction",
            ...(params.communityId && {
                communityId: new ObjectId(params.communityId),
            }),
            ...(params.stage && {
                "construction.currentStage": params.stage,
            }),
        });

        return this.col
            .find(filter, {
                projection: {
                    lotNumber: 1, address: 1, communityName: 1,
                    agentName: 1, "construction.currentStage": 1,
                    "construction.pctComplete": 1,
                },
            })
            .sort({ "construction.pctComplete": -1 }) // furthest along first
            .toArray();
    }

    // ── reserveLot — atomic claim ────────────────────────────────────────────
    // WHY: Two agents can try to reserve the same lot simultaneously.
    //      A read-then-write approach has a race condition window.
    // HOW: findOneAndUpdate with a status guard in the filter.
    //      If the lot was already taken, the filter matches nothing → returns null.
    //      The caller treats null as "lot taken" — no explicit error needed.
    async reserveLot(
        lotId: string,
        buyerEmail: string,
        expiryHours = 24
    ): Promise<Lot | null> {
        return this.col.findOneAndUpdate(
            this.base({
                _id: new ObjectId(lotId),
                status: "available",             // guard — atomic, no race condition
            }),
            {
                $set: {
                    status: "reserved",
                    reservedFor: buyerEmail,
                    reservedAt: new Date(),
                    reserveExpiry: new Date(Date.now() + expiryHours * 3_600_000),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );
    }
}

// ── How a service uses the facade ─────────────────────────────────────────
// The service never touches MongoClient, Collection, or ObjectId.
// Tenant scoping is guaranteed by the constructor — can't be bypassed.

async function facade_usage() {
    const db = await getDb();
    const col = db.collection<Lot>("lots");

    // Instantiate once per request — pass from DI container in production
    const repo = new LotRepository(col, "tenant_highland_homes");

    // Domain-language calls — no MongoDB syntax leaking into service layer
    const lot       = await repo.findById("6650abc123def456789012ab");
    const available = await repo.findAvailable({ communityId: "664f...", maxPrice: 520_000 });
    const inBuild   = await repo.findInConstruction({ stage: "framing" });
    const claimed   = await repo.reserveLot("6650abc123def456789012ab", "jane@example.com");

    console.log("Lot:", lot?.address);
    console.log("Available lots:", available.length);
    console.log("In framing:", inBuild.length);
    console.log("Reservation result:", claimed ? "claimed" : "already taken");
}

// ─────────────────────────────────────────────────────────────────────────────
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  $group + $facet aggregation pipeline                       ║
// ║                                                                          ║
// ║  WHY:  The sales director opens the revenue dashboard. They need:        ║
// ║          1. Total revenue and count, grouped by community                ║
// ║          2. Breakdown of closings by month (trend line)                  ║
// ║          3. Agent leaderboard for the current year                       ║
// ║          4. Price tier distribution (entry / mid / luxury)               ║
// ║        All of this from ONE query — not four separate round trips.       ║
// ║                                                                          ║
// ║  HOW:  $match narrows to closed lots (hits the index).                  ║
// ║        $facet fans out to four independent $group sub-pipelines on the   ║
// ║        same filtered document set. Each sub-pipeline runs in parallel    ║
// ║        inside the server — one network round trip, four result sets.     ║
// ║                                                                          ║
// ║        WHY $group over JS map/reduce:                                    ║
// ║          $group runs server-side on the raw BSON — no data transfer.     ║
// ║          Summing 500K contract prices in JS requires sending 500K docs   ║
// ║          over the wire first. $group sends back one number.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// Typed output interfaces — pass as generic to aggregate<T>()
interface CommunityRevenue {
    communityId: string;
    communityName: string;
    totalRevenue: number;
    avgPrice: number;
    closedLots: number;
}

interface MonthlyClosing {
    year: number;
    month: number;
    count: number;
    revenue: number;
}

interface AgentStat {
    agentId: string;
    agentName: string;
    ytdSales: number;
    ytdRevenue: number;
}

interface PriceTier {
    tier: "entry" | "mid" | "luxury";
    count: number;
    avgPrice: number;
}

interface RevenueDashboard {
    byCommunity: CommunityRevenue[];
    byMonth: MonthlyClosing[];
    agentLeaderboard: AgentStat[];
    byPriceTier: PriceTier[];
}

async function group_facet(
    tenantId: string,
    year: number = new Date().getFullYear()
): Promise<RevenueDashboard> {
    const db = await getDb();
    const col = db.collection<Lot>("lots");

    // ── Year boundary dates ───────────────────────────────────────────────────
    const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
    const yearEnd   = new Date(`${year}-12-31T23:59:59.999Z`);

    // ── Single aggregation pipeline with $facet ───────────────────────────────
    // The $match stage is the most important line in this pipeline.
    // It runs first and reduces 500K total lots down to, say, 800 closed-this-year
    // docs. $facet then fans out over those 800 docs — not 500K.
    //
    // WHY $facet instead of four separate aggregate() calls:
    //   Four calls = four round trips + four $match scans.
    //   $facet = one round trip + one $match scan → ~4x faster wall-clock time.

    const [result] = await col.aggregate<{ raw: RevenueDashboard }>([

        // ──$match — hit the index, narrow the working set ─────────────
        // Index: { tenantId: 1, status: 1, updatedAt: -1 }
        // Equality(tenantId) → Equality(status) → Range(updatedAt) = ESR order ✓
        { $match: {
                tenantId,
                status: "closed",
                updatedAt: { $gte: yearStart, $lte: yearEnd },
            }},

        // ── add a computed "priceTier" field before $facet ─────────────
        // We compute this once here. If we computed it inside each facet
        // sub-pipeline, we'd duplicate the $switch logic 4 times.
        { $addFields: {
                priceTier: {
                    $switch: {
                        branches: [
                            { case: { $lte: ["$pricing.contractPrice", 350_000] }, then: "entry"  },
                            { case: { $lte: ["$pricing.contractPrice", 600_000] }, then: "mid"    },
                        ],
                        default: "luxury",
                    },
                },
            }},

        // ── $facet — four parallel $group pipelines ────────────────────
        { $facet: {

                // ── Sub-pipeline A: revenue by community ────────────────────────────
                // $group key is communityId. Accumulators run server-side.
                // $first picks the community name from any document in the group
                // (they're all the same value — extended ref pattern).
                byCommunity: [
                    { $group: {
                            _id: "$communityId",
                            communityName: { $first: "$communityName" },
                            totalRevenue:  { $sum:   "$pricing.contractPrice" },
                            avgPrice:      { $avg:   "$pricing.contractPrice" },
                            closedLots:    { $sum:   1 },
                        }},
                    { $sort: { totalRevenue: -1 } },
                    { $project: {
                            communityId:   { $toString: "$_id" },
                            communityName: 1,
                            totalRevenue:  { $round: ["$totalRevenue", 0] },
                            avgPrice:      { $round: ["$avgPrice",     0] },
                            closedLots:    1,
                            _id: 0,
                        }},
                ],

                // ── Sub-pipeline B: closings by calendar month ───────────────────────
                // WHY group on { year, month } and not just month:
                //   If data spans multiple years, grouping on month alone merges
                //   Jan 2023 and Jan 2024. Always include the year in the group key.
                byMonth: [
                    { $group: {
                            _id: {
                                year:  { $year:  "$updatedAt" },
                                month: { $month: "$updatedAt" },
                            },
                            count:   { $sum: 1 },
                            revenue: { $sum: "$pricing.contractPrice" },
                        }},
                    { $sort: { "_id.year": 1, "_id.month": 1 } },
                    { $project: {
                            year:    "$_id.year",
                            month:   "$_id.month",
                            count:   1,
                            revenue: { $round: ["$revenue", 0] },
                            _id: 0,
                        }},
                ],

                // ── Sub-pipeline C: agent leaderboard ───────────────────────────────
                // WHY we can use agentName directly without a $lookup:
                //   The extended reference pattern on the lots document stores
                //   agentName at write time. Reads never need to join agents collection.
                //   The tradeoff: if an agent renames, we need to update all their lots.
                //   For a leaderboard this is acceptable — names rarely change mid-year.
                agentLeaderboard: [
                    { $group: {
                            _id: "$agentId",
                            agentName:  { $first: "$agentName" },
                            ytdSales:   { $sum:   1 },
                            ytdRevenue: { $sum:   "$pricing.contractPrice" },
                        }},
                    { $sort: { ytdRevenue: -1 } },
                    { $limit: 10 },
                    { $project: {
                            agentId:    { $toString: "$_id" },
                            agentName:  1,
                            ytdSales:   1,
                            ytdRevenue: { $round: ["$ytdRevenue", 0] },
                            _id: 0,
                        }},
                ],

                // ── Sub-pipeline D: price tier distribution ──────────────────────────
                // $addFields added priceTier before $facet — we just group on it here.
                // WHY not compute $switch again inside this sub-pipeline:
                //   $facet sub-pipelines all share the same pre-$facet documents.
                //   The priceTier field is already on every document from $addFields.
                byPriceTier: [
                    { $group: {
                            _id:      "$priceTier",
                            count:    { $sum: 1 },
                            avgPrice: { $avg: "$pricing.contractPrice" },
                        }},
                    { $sort: { avgPrice: 1 } },
                    { $project: {
                            tier:     "$_id",
                            count:    1,
                            avgPrice: { $round: ["$avgPrice", 0] },
                            _id: 0,
                        }},
                ],
            }},

    ]).toArray() as any;

    // $facet always returns exactly one document containing the four arrays
    return {
        byCommunity:      result.byCommunity      ?? [],
        byMonth:          result.byMonth          ?? [],
        agentLeaderboard: result.agentLeaderboard ?? [],
        byPriceTier:      result.byPriceTier      ?? [],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — Unit Test Utility
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    const TENANT = "highland_homes";

    console.log("\n═══ List collections + filter ═══");
    const { collections, activeCommunities } = await listAndFilter(TENANT);
    console.log("Collections:", collections);
    console.log("Active communities:", activeCommunities.length);

    console.log("\n═══ Find / filter / sort with cursor pagination ═══");
    const { lots, nextCursor } = await findFilterSort({
        tenantId: TENANT,
        communityId: "664f000000000000000000ab",
        minPrice: 400_000,
        maxPrice: 600_000,
        loanTypes: ["VA", "conventional"],
        pageSize: 10,
    });
    console.log(`Page 1: ${lots.length} lots, nextCursor: ${nextCursor}`);

    console.log("\n═══ Facade / repository pattern ═══");
    await facade_usage();

    console.log("\n═══ $group + $facet revenue dashboard ═══");
    const dashboard = await group_facet(TENANT, 2025);
    console.log("Communities:", dashboard.byCommunity.length);
    console.log("Monthly points:", dashboard.byMonth.length);
    console.log("Top agent:", dashboard.agentLeaderboard[0]?.agentName);
    console.log("Price tiers:", dashboard.byPriceTier.map((t) => t.tier).join(", "));

    await client.close();
}

main().catch(console.error);
