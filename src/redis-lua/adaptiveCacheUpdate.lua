local dataKey = KEYS[1]
local metaKey = KEYS[2]
local hash = ARGV[1]
local data = ARGV[2]
local initialTTL = tonumber(ARGV[3])
local maxTTL = tonumber(ARGV[4])
local ttlScaling = tonumber(ARGV[5])

if ARGV[13] and ARGV[13] ~= '' and redis.call('GET', ARGV[13]) ~= ARGV[14] then
  return {'INVALIDATED', 0}
end
local prefix = ARGV[8] or ''
local key = ARGV[9] or string.gsub(dataKey, 'data$', '')
local stateKey = dataKey .. ':state'
local legacy = redis.call('GET', '__adaptive:legacy-barrier')
local barrier = redis.call('GET', prefix .. '__adaptive:barrier')
local generation = redis.call('GET', prefix .. '__adaptive:namespace')
if ARGV[7] and ARGV[7] ~= '' then
  if not legacy or not barrier or not generation or ARGV[7] ~= legacy .. ':' .. barrier .. ':' .. generation then
    return {'INVALIDATED', 0}
  end
end
local uuid = ARGV[15] or redis.sha1hex(dataKey .. table.concat(redis.call('TIME'), ':') .. tostring(math.random()))
local tagsJson = ARGV[10] or '[]'
local tags = cjson.decode(tagsJson)
if type(tags) ~= 'table' or not string.match(tagsJson, '^%s*%[') then
  return redis.error_reply('Invalid adaptive cache tags: expected an array')
end
for _, tag in ipairs(tags) do
  if type(tag) ~= 'string' or #tag == 0 then
    return redis.error_reply('Invalid adaptive cache tags: expected non-empty strings')
  end
end

local namespaceMissing = not generation
generation = generation or uuid
local old = redis.call('HMGET', stateKey, 'prefix', 'tags', 'generation')
if not old[1] then
  local previousData = redis.call('GET', dataKey)
  local marker = '@ac-redis:1:'
  if previousData and string.sub(previousData, 1, #marker) == marker then
    local previous = cjson.decode(string.sub(previousData, #marker + 1))
    old = {previous.prefix, cjson.encode(previous.tags), previous.namespace}
  end
end
local resetMetadata = old[3] and old[3] ~= generation
local oldTags = old[1] and old[2] and cjson.decode(old[2]) or {}

-- Fetch only the fields used for TTL adaptation.
local metaData = resetMetadata and {} or redis.call('HMGET', metaKey, 'dataTTL', 'lastChanged', 'changeCount', 'hash', 'ttlPolicyState')
local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local policy = ARGV[16] and cjson.decode(ARGV[16]) or {type = 'adaptive'}
local policyState = metaData[5] and cjson.decode(metaData[5]) or nil
local nextPolicyState = nil

-- Initialize values
local dataTTL = tonumber(metaData[1]) or initialTTL
local isChanged = metaData[4] ~= hash
local now = isChanged and tonumber(clock[1]) or nil
local lastChanged = isChanged and now or tonumber(metaData[2]) or 0
local changeCount = tonumber(metaData[3] or "0")

if policy.type ~= 'adaptive' then
    local mass = 0
    if policy.type == 'ewma' then
        local p = policy.targetChangeProbability
        -- log(1-p) loses small probabilities to cancellation.
        mass = p < 0.0001 and (p + p^2/2 + p^3/3 + p^4/4 + p^5/5) or -math.log(1-p)
    end
    if not policyState or policyState.signature ~= ARGV[16] then
        dataTTL = initialTTL
        nextPolicyState = {signature = ARGV[16], observedAt = nowMs, observedHash = hash, changeRate = mass / initialTTL}
    else
        nextPolicyState = policyState
        local target = dataTTL
        local shouldRound = true
        if policy.type == 'aimd' then
            target = isChanged and dataTTL * policy.decreaseFactor or dataTTL + policy.increaseSeconds
        else
            local elapsed = (nowMs - policyState.observedAt) / 1000
            if elapsed > 0 then
                local x = math.log(2) * elapsed / policy.halfLifeSeconds
                local alpha = x < 0.0001 and (x - x^2/2 + x^3/6 - x^4/24 + x^5/120) or 1-math.exp(-x)
                local sample = policyState.observedHash ~= hash and 1/elapsed or 0
                local rate = (1-alpha) * policyState.changeRate + alpha * sample
                nextPolicyState = {signature = ARGV[16], observedAt = nowMs, observedHash = hash, changeRate = rate}
                target = rate > 0 and mass/rate or maxTTL
            else
                shouldRound = false
            end
        end
        -- AIMD uses exact ceil; EWMA tolerates only tiny, bounded cjson roundoff.
        target = math.max(initialTTL, math.min(maxTTL, target))
        local tolerance = policy.type == 'ewma' and math.min(0.0000001, math.abs(target) * 1e-12) or 0
        dataTTL = shouldRound and math.ceil(target - tolerance) or target
        dataTTL = math.max(initialTTL, math.min(maxTTL, dataTTL))
    end
elseif policyState then
    -- Switching back to adaptive starts a new history; legacy adaptive metadata has no state.
    dataTTL = initialTTL
elseif not isChanged then
    -- Calculate new TTL
    if dataTTL >= maxTTL then
        dataTTL = maxTTL
    else 
        local decayFactor = 1.0 - math.min(0.9, changeCount * 0.01)
        local increaseFactor = ttlScaling - 1
        if increaseFactor < 0 then increaseFactor = 0 end
        local increase = math.ceil(math.floor(dataTTL * increaseFactor) * decayFactor)
        dataTTL = math.max(initialTTL, math.min(dataTTL + increase, maxTTL))
    end
else
    -- Reset TTL to initial on change to adapt quickly
    dataTTL = initialTTL
end

if isChanged then changeCount = changeCount + 1 end
dataTTL = math.min(dataTTL, maxTTL)
local freshSeconds = dataTTL * tonumber(ARGV[12] or '1')
local staleSeconds = tonumber(ARGV[11] or '0')
if not (freshSeconds > -math.huge and staleSeconds and staleSeconds > -math.huge) then
  return redis.error_reply('Invalid adaptive cache data expiry')
end
local freshTTL = math.max(0.001, freshSeconds)
local retentionMs = math.max(1, math.floor((freshTTL + math.max(0, staleSeconds)) * 1000))
local metaPttlMs = math.floor((tonumber(ARGV[6]) or 0) * 1000)
local maxPttlMs = 2147483647000
if not (metaPttlMs >= 1 and metaPttlMs <= maxPttlMs) then
  return redis.error_reply('Invalid adaptive cache metadata expiry')
end
if not (retentionMs >= 1 and retentionMs <= maxPttlMs) then
  return redis.error_reply('Invalid adaptive cache data expiry')
end
local statePttlMs = math.max(retentionMs, metaPttlMs)
local freshUntil = nowMs + math.floor(freshTTL * 1000)
local nextPolicyJson = nextPolicyState and cjson.encode(nextPolicyState)

-- Complete validation before writing: Redis does not roll back failed scripts.
if namespaceMissing then redis.call('SET', prefix .. '__adaptive:namespace', generation) end
if resetMetadata then redis.call('DEL', metaKey) end
for _, tag in ipairs(oldTags) do
  redis.call('SREM', old[1] .. 'tag:' .. tag, key)
  redis.call('ZREM', old[1] .. '__adaptive:tag-index:' .. tag, key)
end
if nextPolicyState then
    redis.call('HSET', metaKey, 'ttlPolicyState', nextPolicyJson)
else
    redis.call('HDEL', metaKey, 'ttlPolicyState')
end
local epochs = {}
redis.call('HSET', stateKey, 'prefix', prefix, 'tags', tagsJson, 'generation', generation, 'freshUntil', freshUntil, 'revision', uuid)
redis.call('PEXPIRE', stateKey, statePttlMs)
for _, tag in ipairs(tags) do
  local epochKey = prefix .. '__adaptive:tag-epoch:' .. tag
  local epoch = redis.call('GET', epochKey)
  if not epoch then epoch = uuid; redis.call('SET', epochKey, epoch) end
  epochs[epochKey] = epoch
  local indexKey = prefix .. '__adaptive:tag-index:' .. tag
  -- Bound foreground pruning even when many members expired between writes.
  local expired = redis.call('ZRANGEBYSCORE', indexKey, '-inf', nowMs, 'LIMIT', 0, 100)
  if #expired > 0 then redis.call('ZREM', indexKey, unpack(expired)) end
  redis.call('ZADD', indexKey, nowMs + retentionMs, key)
  -- Index lifetime must never be shortened below another member's lifetime.
  if redis.call('PTTL', epochKey) < statePttlMs then redis.call('PEXPIRE', epochKey, statePttlMs) end
  if redis.call('PTTL', indexKey) < statePttlMs then
    redis.call('PEXPIRE', indexKey, statePttlMs)
  end
end
-- Store new metadata
redis.call('HSET', metaKey, 
  'hash', hash, 
  'dataTTL', dataTTL, 
  'lastChanged', lastChanged, 
  'changeCount', changeCount)
-- Set expiration for metadata
redis.call('PEXPIRE', metaKey, metaPttlMs)
-- Store actual data with updated TTL
redis.call('SET', dataKey .. ':revision', uuid, 'PX', retentionMs)
local envelope = {revision = uuid, data = data, prefix = prefix, namespace = generation, freshUntil = freshUntil, epochs = epochs, tags = tags}
redis.call('SET', dataKey, '@ac-redis:1:' .. cjson.encode(envelope), 'PX', retentionMs)

-- RESP numeric replies truncate fractions. Preserve every policy's TTL as decimal text.
local resultTTL = string.format('%.17g', dataTTL)
return {'CACHED', resultTTL, lastChanged, changeCount, hash, isChanged and 1 or 0}
