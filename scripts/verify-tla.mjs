import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tlaDir = path.join(root, 'formal', 'tla')

const specs = [
  { name: 'AdaptiveCacheFencing', tla: 'AdaptiveCacheFencing.tla', cfg: 'AdaptiveCacheFencing.cfg', liveness: false },
  {
    name: 'CacheLoaderCoordination',
    tla: 'CacheLoaderCoordination.tla',
    cfg: 'CacheLoaderCoordination.cfg',
    liveness: true,
  },
  {
    name: 'FastifyCoalescedPublication',
    tla: 'FastifyCoalescedPublication.tla',
    cfg: 'FastifyCoalescedPublication.cfg',
    liveness: true,
  },
  {
    name: 'L1RedisDrainAndLifecycle',
    tla: 'L1RedisDrainAndLifecycle.tla',
    cfg: 'L1RedisDrainAndLifecycle.cfg',
    liveness: true,
  },
]

export const findJava = () => {
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', 'java')
    if (fs.existsSync(candidate)) return candidate
  }
  const candidates = ['/opt/homebrew/opt/openjdk@21/bin/java', '/opt/homebrew/opt/openjdk/bin/java', 'java']
  for (const candidate of candidates) {
    const check = spawnSync(candidate, ['-version'], { stdio: 'ignore' })
    if (check.status === 0) return candidate
  }
  return null
}

export const findTlaJar = () => {
  const candidates = [
    process.env.TLA2TOOLS_JAR,
    path.join(root, 'formal', 'tla', 'tla2tools.jar'),
    '/Volumes/Scratch/adaptive-cache/tools/tla2tools.jar',
    '/Volumes/Scratch/ensemble-contracts/tools/tla-1.7.4/tla2tools.jar',
    '/Volumes/Scratch/SnowskyEcho/tools/tla/tla2tools.jar',
    path.join(os.homedir(), '.tla', 'tla2tools.jar'),
    '/usr/local/lib/tla2tools.jar',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const java = findJava()
  if (!java) throw new Error('Java runtime not found. Install OpenJDK 21+ or set JAVA_HOME.')
  const jar = findTlaJar()
  if (!jar) {
    throw new Error('tla2tools.jar not found. Download TLA+ tools and set TLA2TOOLS_JAR=/path/to/tla2tools.jar.')
  }

  const workers = process.env.TLC_WORKERS || process.env.COMPUTE_JOBS || 'auto'
  const metaBase = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adaptive-cache-tlc-'))

  try {
    for (const spec of specs) {
      const metadir = path.join(metaBase, spec.name)
      fs.mkdirSync(metadir, { recursive: true })
      console.log(`\n=== TLC: ${spec.name} (${spec.liveness ? 'safety + liveness' : 'safety'}) ===`)
      const args = [
        '-XX:+UseParallelGC',
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        workers,
        '-deadlock',
        '-metadir',
        metadir,
        '-config',
        path.join(tlaDir, spec.cfg),
        path.join(tlaDir, spec.tla),
      ]
      const result = spawnSync(java, args, { stdio: 'inherit' })
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1
        break
      }
    }
  } finally {
    fs.rmSync(metaBase, { recursive: true, force: true })
  }
}
