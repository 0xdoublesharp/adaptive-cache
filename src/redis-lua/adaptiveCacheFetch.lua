local dataKey = KEYS[1]
local metaKey = string.gsub(dataKey, 'data$', 'meta')
local data = redis.call('GET', dataKey)
if not data then return {false, 0} end
local freshUntil = nil
local revision = false
local marker = '@ac-redis:1:'
if string.sub(data, 1, #marker) == marker then
  local envelope = cjson.decode(string.sub(data, #marker + 1))
  if redis.call('GET', envelope.prefix .. '__adaptive:namespace') ~= envelope.namespace then return {false, 0} end
  for key, epoch in pairs(envelope.epochs) do
    if redis.call('GET', key) ~= epoch then return {false, 0} end
  end
  if envelope.revision and redis.call('GET', dataKey .. ':revision') == envelope.revision then revision = envelope.revision end
  freshUntil = envelope.freshUntil
  data = envelope.data
else
  -- Pre-envelope entries remain readable during a rolling upgrade.
  local state = redis.call('HMGET', dataKey .. ':state', 'prefix', 'generation', 'freshUntil')
  if state[1] and state[2] ~= redis.call('GET', state[1] .. '__adaptive:namespace') then return {false, 0} end
  freshUntil = tonumber(state[3])
end
local ttl = redis.call('TTL', dataKey)
local remainingMs = math.max(0, redis.call('PTTL', dataKey))
local stale = false
local staleAge = 0
if freshUntil then
  local clock = redis.call('TIME')
  local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  local remaining = freshUntil - nowMs
  stale = remaining <= 0
  if stale and ARGV[1] ~= '1' then return {false, 0} end
  -- Floor preserves integer-second TTL semantics; remainingMs preserves sub-second freshness.
  ttl = math.max(0, math.floor(remaining / 1000))
  remainingMs = math.max(0, remaining)
  staleAge = math.max(0, -remaining)
end
local meta = redis.call('HMGET', metaKey, 'dataTTL', 'lastChanged', 'changeCount', 'hash')
return {data, ttl, meta[1] or false, meta[2] or false, meta[3] or false, meta[4] or false, stale and 1 or 0, staleAge, revision, remainingMs}
