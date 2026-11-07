local lastUpdateKey = KEYS[1]  -- Key storing last update timestamp
local lockKey = KEYS[2]  -- Key storing the lock
local currentTime = tonumber(ARGV[1])  -- Current timestamp
local lockValue = ARGV[2]  -- The unique lock value expected

-- Get the current lock value
local existingLock = redis.call("GET", lockKey)

-- Only the live owner may record refresh success and release the lock.
if existingLock == lockValue then
    -- Loader locks do not need the public refresh helper's timestamp marker.
    if ARGV[3] ~= '0' then redis.call("SET", lastUpdateKey, currentTime) end
    redis.call("DEL", lockKey)
    return {"UPDATED"}
else
    return {"LOCK_MISMATCH", existingLock or ""}
end
