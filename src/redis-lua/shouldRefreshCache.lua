local lastUpdateKey = KEYS[1]  -- Key storing last update timestamp
local lockKey = KEYS[2]  -- Key storing the lock
local currentTime = tonumber(ARGV[1])  -- Current timestamp
local refreshThreshold = tonumber(ARGV[2])  -- How old the data can be before refresh
local lockExpiration = tonumber(ARGV[3])  -- Lock expiration time in milliseconds
local lockValue = ARGV[4]  -- Unique lock value (e.g., UUID)
local force = tonumber(ARGV[5])  -- Force refresh flag (1 = force, 0 = normal check)

local lastUpdate = -1
if force ~= 1 then
    -- Get the last update timestamp
    local lastUpdateValue = redis.call("GET", lastUpdateKey)
    local lastUpdateNum = lastUpdateValue and tonumber(lastUpdateValue) or nil
    -- If not forced and the data is still fresh, return "EXISTS"
    if lastUpdateNum ~= nil then
        lastUpdate = lastUpdateNum
        if currentTime - lastUpdate < refreshThreshold then
            return { "EXISTS", refreshThreshold - (currentTime - lastUpdate) }
        end
    end

    -- Check if another instance is already updating
    local existingLock = redis.call("GET", lockKey)
    if existingLock and existingLock ~= lockValue then
        return { "UPDATING", existingLock }
    end
end

-- If forcing, override the lock
redis.call("SET", lockKey, lockValue, "PX", lockExpiration)

-- Indicate that this instance should update the cache and return the lock key
return { "UPDATE", lockValue, lastUpdate }
