import type {
  AdaptiveCacheMetadata,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheTtlPolicy,
  AdaptiveCacheTtlPolicyState,
} from '../types'
import { calculatePolicyTTL } from '../ttlCalculation'

export const METADATA_SIZE_OVERHEAD_BYTES = 512
const ENVELOPE_STRUCTURE_OVERHEAD_BYTES = 256

export interface LruEnvelope {
  encodedData: string
  hash: string
  dataTTL: number
  ttlPolicyState?: AdaptiveCacheTtlPolicyState
  lastChanged: number
  changeCount: number
  tags: string[]
  createdAt: number
  updatedAt: number
  expiresAt: number
  freshUntil?: number
  namespaceGeneration?: string
  prefix: string
  revision?: string
  writeToken?: string
  epochs?: Record<string, string>
}

export const toFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export const calculateNextMetadata = (
  previous: (AdaptiveCacheMetadata & { namespaceGeneration?: string }) | undefined,
  hash: string,
  initialTTL: number,
  maxTTL: number,
  ttlScaling: number,
  ttlPolicy?: AdaptiveCacheTtlPolicy,
  nowMs = Date.now(),
  namespaceGeneration?: string,
) => {
  if (previous && namespaceGeneration !== undefined && previous.namespaceGeneration !== namespaceGeneration)
    previous = undefined
  const isChanged = !previous || previous.hash !== hash
  let dataTTL = toFiniteNumber(previous?.dataTTL, initialTTL)
  let lastChanged = toFiniteNumber(previous?.lastChanged, 0)
  let changeCount = toFiniteNumber(previous?.changeCount, 0)

  let ttlPolicyState: AdaptiveCacheTtlPolicyState | undefined
  if ((ttlPolicy && ttlPolicy.type !== 'adaptive') || previous?.ttlPolicyState) {
    const calculated = calculatePolicyTTL(
      dataTTL,
      previous?.ttlPolicyState,
      isChanged,
      hash,
      initialTTL,
      maxTTL,
      ttlPolicy || { type: 'adaptive' },
      nowMs,
    )
    dataTTL = calculated.dataTTL
    ttlPolicyState = calculated.ttlPolicyState
  } else if (!isChanged) {
    if (dataTTL >= maxTTL) {
      dataTTL = maxTTL
    } else {
      const decayFactor = 1.0 - Math.min(0.9, changeCount * 0.01)
      const increaseFactor = Math.max(0, ttlScaling - 1)
      const increase = Math.ceil(Math.floor(dataTTL * increaseFactor) * decayFactor)
      dataTTL = Math.max(initialTTL, Math.min(dataTTL + increase, maxTTL))
    }
  } else {
    dataTTL = initialTTL
  }

  if (isChanged) {
    changeCount += 1
    lastChanged = Math.floor(nowMs / 1000)
  }
  return { dataTTL, lastChanged, changeCount, changed: isChanged, ...(ttlPolicyState ? { ttlPolicyState } : {}) }
}

export function metadataFromEnvelope(envelope: LruEnvelope): AdaptiveCacheMetadata & { namespaceGeneration?: string } {
  return {
    dataTTL: envelope.dataTTL,
    lastChanged: envelope.lastChanged,
    changeCount: envelope.changeCount,
    hash: envelope.hash,
    ...(envelope.namespaceGeneration ? { namespaceGeneration: envelope.namespaceGeneration } : {}),
    ...(envelope.ttlPolicyState ? { ttlPolicyState: envelope.ttlPolicyState } : {}),
  }
}

export function createEnvelope(
  input: AdaptiveCacheBackendUpdateInput,
  metadata: Required<Pick<AdaptiveCacheMetadata, 'dataTTL' | 'lastChanged' | 'changeCount' | 'hash'>> &
    Pick<LruEnvelope, 'ttlPolicyState' | 'namespaceGeneration'>,
): LruEnvelope {
  const dataTTL = Math.min(input.maxTTL, toFiniteNumber(metadata.dataTTL, input.initialTTL))
  const freshTTL = dataTTL * (1 - Math.random() * (input.ttlJitter || 0))
  const now = Date.now()

  return {
    encodedData: input.encodedData,
    writeToken: input.writeToken,
    hash: metadata.hash,
    ...(metadata.namespaceGeneration ? { namespaceGeneration: metadata.namespaceGeneration } : {}),
    ...(metadata.ttlPolicyState ? { ttlPolicyState: metadata.ttlPolicyState } : {}),
    dataTTL,
    lastChanged: toFiniteNumber(metadata.lastChanged, 0),
    changeCount: toFiniteNumber(metadata.changeCount, 0),
    tags: input.tags,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (freshTTL + (input.staleTTL || 0)) * 1000,
    freshUntil: now + freshTTL * 1000,
    prefix: input.redisPrefix,
  }
}

export function estimateEnvelopeSize(envelope: LruEnvelope) {
  const { encodedData, ...metadata } = envelope
  return (
    Buffer.byteLength(encodedData) + Buffer.byteLength(JSON.stringify(metadata)) + ENVELOPE_STRUCTURE_OVERHEAD_BYTES
  )
}
