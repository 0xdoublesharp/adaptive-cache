import { calculateNextMetadata } from '../../src/backends/lruEnvelope'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'

type PipelineCommand = () => unknown | Promise<unknown>

interface StoredValue {
  value: string
}

export class FakeRedis {
  public status = 'ready'
  public options = { host: 'fake', port: 6379 }
  public events = new Map<string, Array<(...args: any[]) => void>>()
  public stores = {
    values: new Map<string, StoredValue>(),
    hashes: new Map<string, Record<string, string>>(),
    sets: new Map<string, Set<string>>(),
    sortedSets: new Map<string, Map<string, number>>(),
    expiresAt: new Map<string, number>(),
  }
  public published: Array<{ channel: string; payload: string }> = []
  public subscribedChannels: string[] = []
  public failUpdate = false
  public failFetch = false
  public failPublish = false
  public failSubscribe = false
  public failDuplicate = false
  public defineCommandCalls: string[] = []
  public quitCalls = 0
  public disconnectCalls = 0

  constructor(stores?: FakeRedis['stores'] | Record<string, unknown> | string, options?: Record<string, unknown>) {
    if (typeof stores === 'string') {
      const url = new URL(stores)
      this.options = {
        host: url.hostname,
        port: url.port ? Number(url.port) : 6379,
        ...(options || {}),
      } as typeof this.options
      return
    }

    if (stores && stores.values instanceof Map && stores.hashes instanceof Map && stores.sets instanceof Map) {
      this.stores = stores as FakeRedis['stores']
    } else if (stores) {
      this.options = { ...this.options, ...stores }
    }
  }

  defineCommand(name: string) {
    this.defineCommandCalls.push(name)
  }

  on(event: string, handler: (...args: any[]) => void) {
    const handlers = this.events.get(event) || []
    handlers.push(handler)
    this.events.set(event, handlers)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.events.get(event) || []) handler(...args)
  }

  duplicate() {
    if (this.failDuplicate) throw new Error('duplicate failed')
    const duplicate = new FakeRedis(this.stores)
    duplicate.failSubscribe = this.failSubscribe
    duplicate.failPublish = this.failPublish
    return duplicate
  }

  async subscribe(channel: string) {
    if (this.failSubscribe) throw new Error('subscribe failed')
    this.subscribedChannels.push(channel)
    return 1
  }

  async publish(channel: string, payload: string) {
    if (this.failPublish) throw new Error('publish failed')
    this.published.push({ channel, payload })
    return 1
  }

  async get(key: string) {
    this.expireKey(key)
    return this.stores.values.get(key)?.value ?? null
  }

  async setnx(key: string, value: string) {
    if (await this.exists(key)) return 0
    await this.set(key, value)
    return 1
  }

  async mget(...keys: string[]) {
    return Promise.all(keys.map((key) => this.get(key)))
  }

  async set(key: string, value: string | number, mode?: string, ttl?: number) {
    this.deleteKey(key)
    this.stores.values.set(key, { value: String(value) })
    if (mode === 'EX' && typeof ttl === 'number') this.stores.expiresAt.set(key, Date.now() + ttl * 1000)
    if (mode === 'PX' && typeof ttl === 'number') this.stores.expiresAt.set(key, Date.now() + ttl)
    return 'OK'
  }

  async del(...keys: string[]) {
    let deleted = 0
    for (const key of keys) {
      this.expireKey(key)
      deleted += this.deleteKey(key)
    }
    return deleted
  }

  private deleteKey(key: string) {
    const deleted = [
      this.stores.values.delete(key),
      this.stores.hashes.delete(key),
      this.stores.sets.delete(key),
      this.stores.sortedSets.delete(key),
    ].some(Boolean)
    this.stores.expiresAt.delete(key)
    return deleted ? 1 : 0
  }

  private expireKey(key: string) {
    const expiresAt = this.stores.expiresAt.get(key)
    if (expiresAt !== undefined && expiresAt <= Date.now()) this.deleteKey(key)
  }

  async expire(key: string, seconds: number) {
    return this.pexpire(key, seconds * 1000)
  }

  async pexpire(key: string, milliseconds: number) {
    if (!(await this.exists(key))) return 0
    if (milliseconds <= 0) return this.deleteKey(key)
    this.stores.expiresAt.set(key, Date.now() + milliseconds)
    return 1
  }

  async exists(key: string) {
    this.expireKey(key)
    return this.stores.values.has(key) ||
      this.stores.hashes.has(key) ||
      this.stores.sets.has(key) ||
      this.stores.sortedSets.has(key)
      ? 1
      : 0
  }

  async hgetall(key: string) {
    this.expireKey(key)
    return this.stores.hashes.get(key) || {}
  }

  async smembers(key: string) {
    this.expireKey(key)
    return Array.from(this.stores.sets.get(key) || [])
  }

  async zrange(key: string, start: number, stop: number) {
    this.expireKey(key)
    const members = [...(this.stores.sortedSets.get(key) || [])].sort((a, b) => a[1] - b[1]).map(([member]) => member)
    return members.slice(start, stop === -1 ? undefined : stop + 1)
  }

  async sscan(key: string, _cursor: string, _count: string, count: number): Promise<[string, string[]]> {
    const members = await this.smembers(key)
    return [members.length > count ? '1' : '0', members.slice(0, count)]
  }

  disconnect() {
    this.disconnectCalls++
    this.status = 'end'
  }

  async flushall() {
    this.stores.values.clear()
    this.stores.hashes.clear()
    this.stores.sets.clear()
    this.stores.sortedSets.clear()
    this.stores.expiresAt.clear()
  }

  async quit() {
    this.quitCalls += 1
    return 'OK'
  }

  pipeline() {
    const commands: PipelineCommand[] = []
    return {
      sadd: (key: string, value: string) => {
        commands.push(() => {
          this.expireKey(key)
          const set = this.stores.sets.get(key) || new Set<string>()
          set.add(value)
          this.stores.sets.set(key, set)
        })
        return this
      },
      expire: (key: string, ttl: number) => {
        commands.push(() => this.expire(key, ttl))
        return this
      },
      del: (...keys: string[]) => {
        commands.push(() => this.del(...keys))
        return this
      },
      exec: async () => {
        for (const command of commands) await command()
        return commands.map(() => [null, 'OK'])
      },
    }
  }

  async adaptiveCacheFetch(dataKey: string, allowStale = '0') {
    if (this.failFetch) throw new Error('fetch failed')
    let data = await this.get(dataKey)
    if (!data) return [null, 0]
    const meta = await this.hgetall(dataKey.replace(/data$/, 'meta'))
    let freshUntil: number | undefined
    let revision: string | undefined
    if (data.startsWith('@ac-redis:1:')) {
      const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
      if (envelope.namespace !== (await this.get(envelope.prefix + '__adaptive:namespace'))) return [null, 0]
      for (const [key, epoch] of Object.entries(envelope.epochs)) if ((await this.get(key)) !== epoch) return [null, 0]
      if (envelope.revision === (await this.get(dataKey + ':revision'))) revision = envelope.revision
      freshUntil = envelope.freshUntil
      data = envelope.data
    }
    const remaining = freshUntil !== undefined ? freshUntil - Date.now() : (await this.ttl(dataKey)) * 1000
    const stale = remaining <= 0
    if (stale && allowStale !== '1') return [null, 0]
    return [
      data,
      Math.max(0, Math.floor(remaining / 1000)),
      meta.dataTTL,
      meta.lastChanged,
      meta.changeCount,
      meta.hash,
      stale ? 1 : 0,
      Math.max(0, -remaining),
      revision,
    ]
  }

  async adaptiveCacheUpdate(
    dataKey: string,
    metaKey: string,
    hash: string,
    data: string,
    initialTTLString: string,
    maxTTLString: string,
    ttlScalingString: string,
    metaTTLString: string,
    writeToken = '',
    prefix = '',
    key = dataKey.replace(/data$/, ''),
    tagsJSON = '[]',
    staleTTLString = '0',
    jitterFactor = '1',
    lockKey = '',
    lockValue = '',
    uuid = randomUUID(),
    policyJSON = '{"type":"adaptive"}',
  ) {
    if (this.failUpdate) throw new Error('update failed')
    if (lockKey && (await this.get(lockKey)) !== lockValue) return ['INVALIDATED', 0]
    const [legacy, barrier, storedGeneration] = await this.mget(
      '__adaptive:legacy-barrier',
      prefix + '__adaptive:barrier',
      prefix + '__adaptive:namespace',
    )
    if (
      writeToken &&
      (!legacy || !barrier || !storedGeneration || writeToken !== [legacy, barrier, storedGeneration].join(':'))
    )
      return ['INVALIDATED', 0]
    this.expireKey(dataKey + ':state')
    let old = this.stores.hashes.get(dataKey + ':state')
    const previousData = await this.get(dataKey)
    if (!old && previousData?.startsWith('@ac-redis:1:')) {
      const previous = JSON.parse(previousData.slice('@ac-redis:1:'.length))
      old = { prefix: previous.prefix, tags: JSON.stringify(previous.tags), generation: previous.namespace }
    }
    for (const tag of JSON.parse(old?.tags || '[]')) {
      this.expireKey((old?.prefix || '') + 'tag:' + tag)
      this.expireKey((old?.prefix || '') + '__adaptive:tag-index:' + tag)
      this.stores.sets.get((old?.prefix || '') + 'tag:' + tag)?.delete(key)
      this.stores.sortedSets.get((old?.prefix || '') + '__adaptive:tag-index:' + tag)?.delete(key)
    }
    const generation = storedGeneration || uuid
    await this.setnx(prefix + '__adaptive:namespace', generation)
    if (old && old.generation !== generation) await this.del(metaKey)
    const epochs: Record<string, string> = {}

    const initialTTL = Number(initialTTLString)
    const maxTTL = Number(maxTTLString)
    const ttlScaling = Number(ttlScalingString)
    const meta = await this.hgetall(metaKey)
    const calculated = calculateNextMetadata(
      { ...meta, ttlPolicyState: meta.ttlPolicyState ? JSON.parse(meta.ttlPolicyState) : undefined },
      hash,
      initialTTL,
      maxTTL,
      ttlScaling,
      JSON.parse(policyJSON),
      Date.now(),
    )
    let { dataTTL } = calculated
    const { lastChanged, changeCount, changed: isChanged } = calculated
    this.stores.hashes.set(metaKey, {
      hash,
      dataTTL: String(dataTTL),
      lastChanged: String(lastChanged),
      changeCount: String(changeCount),
      ...(calculated.ttlPolicyState ? { ttlPolicyState: JSON.stringify(calculated.ttlPolicyState) } : {}),
    })
    dataTTL = Math.min(dataTTL, maxTTL)
    const freshTTL = Math.max(0.001, dataTTL * Number(jitterFactor))
    this.stores.hashes.set(dataKey + ':state', {
      prefix,
      tags: tagsJSON,
      generation,
      freshUntil: String(Date.now() + freshTTL * 1000),
      revision: uuid,
    })
    const retention = Math.max(1, Math.floor((freshTTL + Math.max(0, Number(staleTTLString))) * 1000))
    const tagTTL = Math.max(retention, Number(metaTTLString) * 1000)
    await this.pexpire(dataKey + ':state', tagTTL)
    for (const tag of JSON.parse(tagsJSON)) {
      const epochKey = prefix + '__adaptive:tag-epoch:' + tag
      await this.setnx(epochKey, uuid)
      epochs[epochKey] = (await this.get(epochKey))!
      const tagKey = prefix + '__adaptive:tag-index:' + tag
      this.expireKey(tagKey)
      const members = this.stores.sortedSets.get(tagKey) || new Map<string, number>()
      let pruned = 0
      for (const [member, expiry] of members) if (expiry <= Date.now() && pruned++ < 100) members.delete(member)
      members.set(key, Date.now() + retention)
      this.stores.sortedSets.set(tagKey, members)
      for (const retainedKey of [epochKey, tagKey]) {
        if ((this.stores.expiresAt.get(retainedKey) || 0) < Date.now() + tagTTL) {
          await this.pexpire(retainedKey, tagTTL)
        }
      }
    }
    await this.set(dataKey + ':revision', uuid, 'PX', retention)
    await this.set(
      dataKey,
      '@ac-redis:1:' +
        JSON.stringify({
          data,
          revision: uuid,
          prefix,
          namespace: generation,
          freshUntil: Date.now() + freshTTL * 1000,
          epochs,
          tags: JSON.parse(tagsJSON),
        }),
      'PX',
      retention,
    )
    await this.expire(metaKey, Number(metaTTLString))

    return ['CACHED', dataTTL, lastChanged, changeCount, hash, isChanged ? 1 : 0]
  }

  async adaptiveCacheInvalidate(
    legacyKey: string,
    operation: string,
    prefix: string,
    key: string,
    tagsJSON: string,
    barrierUUID = randomUUID(),
    namespaceUUID = randomUUID(),
  ) {
    const barrier = prefix ? prefix + '__adaptive:barrier' : legacyKey
    await this.set(barrier, barrierUUID)
    if (operation === 'namespace') {
      const namespace = prefix + '__adaptive:namespace'
      await this.set(namespace, namespaceUUID)
      return []
    }
    if (operation === 'clear') {
      await this.removeEntry(key)
      return [key]
    }
    const detached: string[] = []
    for (const tag of JSON.parse(tagsJSON)) {
      await this.del(prefix + '__adaptive:tag-epoch:' + tag)
      for (const [source, kind] of [
        [prefix + '__adaptive:tag-index:' + tag, 'zset'],
        [prefix + 'tag:' + tag, 'set'],
      ]) {
        this.expireKey(source)
        const target = source + ':invalidated:' + namespaceUUID
        const store = kind === 'set' ? this.stores.sets : this.stores.sortedSets
        const members = store.get(source)
        if (members?.size) {
          ;(store as Map<string, unknown>).set(target, members)
          store.delete(source)
          this.stores.expiresAt.delete(source)
          await this.pexpire(target, 60000)
          detached.push(tag, target, kind, String(members.size))
        }
      }
    }
    return detached
  }

  private async removeEntry(member: string) {
    this.expireKey(member + 'data:state')
    let state = this.stores.hashes.get(member + 'data:state')
    const data = await this.get(member + 'data')
    if (!state && data?.startsWith('@ac-redis:1:')) {
      const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
      state = { prefix: envelope.prefix, tags: JSON.stringify(envelope.tags) }
    }
    for (const tag of JSON.parse(state?.tags || '[]')) {
      this.expireKey((state?.prefix || '') + 'tag:' + tag)
      this.expireKey((state?.prefix || '') + '__adaptive:tag-index:' + tag)
      this.stores.sets.get((state?.prefix || '') + 'tag:' + tag)?.delete(member)
      this.stores.sortedSets.get((state?.prefix || '') + '__adaptive:tag-index:' + tag)?.delete(member)
    }
    await this.del(member + 'data', member + 'meta', member + 'data:state', member + 'data:revision')
  }

  async adaptiveCacheCleanup(indexKey: string, prefix: string, tag: string, membersJSON: string, kind: string) {
    if (!(await this.exists(indexKey))) return -1
    let removed = 0
    const epochKey = prefix + '__adaptive:tag-epoch:' + tag
    const epoch = await this.get(epochKey)
    for (const member of JSON.parse(membersJSON)) {
      const data = await this.get(member + 'data')
      let remove = true
      if (data?.startsWith('@ac-redis:1:')) {
        const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
        remove = envelope.epochs[epochKey] !== undefined && envelope.epochs[epochKey] !== epoch
      } else {
        this.expireKey(member + 'data:state')
        const state = this.stores.hashes.get(member + 'data:state')
        if (state) remove = JSON.parse(state.tags).includes(tag)
      }
      if (remove) await this.removeEntry(member)
      if (kind === 'zset') removed += this.stores.sortedSets.get(indexKey)?.delete(member) ? 1 : 0
      else removed += this.stores.sets.get(indexKey)?.delete(member) ? 1 : 0
    }
    return removed
  }

  async adaptiveCacheValidate(dataKey: string, prefix: string, token: string, revision: string) {
    if (!revision || (await this.get(dataKey + ':revision')) !== revision || !(await this.get(dataKey))) return 0
    const controls = await this.mget(
      '__adaptive:legacy-barrier',
      prefix + '__adaptive:barrier',
      prefix + '__adaptive:namespace',
    )
    if (controls.some((value) => value === null) || controls.join(':') !== token) return 0
    const data = (await this.get(dataKey))!
    if (!data.startsWith('@ac-redis:1:')) return 0
    const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
    if (envelope.revision !== revision || envelope.prefix !== prefix || envelope.namespace !== controls[2]) return 0
    for (const [key, epoch] of Object.entries(envelope.epochs)) if ((await this.get(key)) !== epoch) return 0
    if (envelope.freshUntil <= Date.now()) return 0
    return 1
  }

  async shouldRefreshCache(
    lastUpdateKey: string,
    lockKey: string,
    currentTime: number,
    refreshThreshold: number,
    lockExpiration: number,
    lockValue: string,
    force: number,
  ) {
    const lastUpdate = force === 1 ? -1 : Number((await this.get(lastUpdateKey)) || '0')
    if (force !== 1 && currentTime - lastUpdate < refreshThreshold) {
      return ['EXISTS', refreshThreshold - (currentTime - lastUpdate)]
    }

    const existingLock = await this.get(lockKey)
    if (force !== 1 && existingLock && existingLock !== lockValue) {
      return ['UPDATING', existingLock]
    }

    await this.set(lockKey, lockValue, 'PX', lockExpiration)
    return ['UPDATE', lockValue, lastUpdate]
  }

  async releaseCacheRefreshLock(
    lastUpdateKey: string,
    lockKey: string,
    currentTime: number,
    lockValue: string,
    recordRefresh = 1,
  ) {
    const existingLock = await this.get(lockKey)
    if (existingLock === lockValue) {
      if (recordRefresh !== 0) await this.set(lastUpdateKey, String(currentTime))
      await this.del(lockKey)
      return ['UPDATED']
    }
    return ['LOCK_MISMATCH', existingLock || '']
  }

  private async ttl(key: string) {
    if (!(await this.exists(key))) return -2
    const expiresAt = this.stores.expiresAt.get(key)
    if (expiresAt === undefined) return -1
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  }
}
