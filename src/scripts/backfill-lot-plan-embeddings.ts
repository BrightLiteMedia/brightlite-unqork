import {
  backfillLotPlanEmbeddings,
  closeLotSearchMongoClient,
} from '../utils/mongoAtlasUtils'

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

async function main() {
  const batchSize = Number(getArgValue('--batch-size') ?? '25')
  const limit = Number(getArgValue('--limit') ?? '100')
  const tenantId = getArgValue('--tenant-id')
  const onlyMissing = !hasFlag('--all')

  const result = await backfillLotPlanEmbeddings({
    tenantId,
    batchSize,
    limit,
    onlyMissing,
  })

  console.log('Lot plan embedding backfill complete.', result)
}

main()
  .catch((error) => {
    console.error('Lot plan embedding backfill failed.')
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeLotSearchMongoClient()
  })
