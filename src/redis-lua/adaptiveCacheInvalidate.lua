-- Invalidation is O(number of requested tags), independent of member count.
local prefix = ARGV[2]
local operation = ARGV[1]
local tags
if operation ~= 'namespace' and operation ~= 'clear' then
  tags = cjson.decode(ARGV[4])
  if #tags == 0 then return {} end
end
local barrier = prefix ~= '' and prefix .. '__adaptive:barrier' or KEYS[1]
redis.call('SET', barrier, ARGV[5])
if operation == 'namespace' then
  redis.call('SET', prefix .. '__adaptive:namespace', ARGV[6])
  return {}
end
if operation == 'clear' then
  local key = ARGV[3]
  local dataKey = key .. 'data'
  local old = redis.call('HMGET', dataKey .. ':state', 'prefix', 'tags')
  if not old[1] then
    local data = redis.call('GET', dataKey)
    local marker = '@ac-redis:1:'
    if data and string.sub(data, 1, #marker) == marker then
      local envelope = cjson.decode(string.sub(data, #marker + 1))
      old = {envelope.prefix, cjson.encode(envelope.tags)}
    end
  end
  if old[1] and old[2] then
    for _, tag in ipairs(cjson.decode(old[2])) do
      redis.call('SREM', old[1] .. 'tag:' .. tag, key)
      redis.call('ZREM', old[1] .. '__adaptive:tag-index:' .. tag, key)
    end
  end
  redis.call('DEL', dataKey, key .. 'meta', dataKey .. ':state', dataKey .. ':revision')
  return {key}
end
local detached = {}
for index, tag in ipairs(tags) do
  local epochKey = prefix .. '__adaptive:tag-epoch:' .. tag
  redis.call('DEL', epochKey)
  local indexKey = prefix .. '__adaptive:tag-index:' .. tag
  local legacyKey = prefix .. 'tag:' .. tag
  for _, source in ipairs({indexKey, legacyKey}) do
    if redis.call('EXISTS', source) == 1 then
      local target = source .. ':invalidated:' .. ARGV[6] .. ':' .. index
      redis.call('RENAME', source, target)
      -- Abandoned cleanup must not retain an index indefinitely.
      redis.call('PEXPIRE', target, 60000)
      table.insert(detached, tag)
      table.insert(detached, target)
      table.insert(detached, source == indexKey and 'zset' or 'set')
      local count = source == indexKey and redis.call('ZCARD', target) or redis.call('SCARD', target)
      table.insert(detached, tostring(count))
    end
  end
end
return detached
