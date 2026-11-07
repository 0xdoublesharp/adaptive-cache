const MAX_TAGS = 1024
const MAX_TAG_BYTES = 4096
const MAX_TAG_PAYLOAD_BYTES = 256 * 1024

export const normalizeCacheTags = (tags: unknown, operation: string) => {
  if (!Array.isArray(tags)) throw new TypeError(`${operation} tags must be an array`)
  if (tags.length > MAX_TAGS) throw new RangeError(`${operation} accepts at most ${MAX_TAGS} tags`)
  const unique = Array.from(new Set(tags))
  for (const tag of unique) {
    if (typeof tag !== 'string') throw new TypeError(`${operation} tags must be strings`)
    if (tag.length === 0) throw new RangeError(`${operation} tags must be non-empty`)
    if (Buffer.byteLength(tag, 'utf8') > MAX_TAG_BYTES)
      throw new RangeError(`${operation} tags must not exceed ${MAX_TAG_BYTES} bytes`)
  }
  const encoded = JSON.stringify(unique)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TAG_PAYLOAD_BYTES)
    throw new RangeError(`${operation} tag payload exceeds ${MAX_TAG_PAYLOAD_BYTES} bytes`)
  return { tags: unique as string[], encoded }
}
