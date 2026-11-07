import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(__filename)
const { build } = createRequire(require.resolve('tsup'))('esbuild')

describe('clustered LRU atomic lock release over IPC', () => {
  it.each([false, true])('protects successor leases; missing bootstrap=%s', async (noBootstrap) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-cache-locks-'))
    const fixture = path.join(directory, 'fixture.cjs')
    const root = path.resolve(__dirname, '..')
    let child: ReturnType<typeof fork> | undefined
    try {
      const result = await build({
        entryPoints: [path.join(__dirname, 'fixtures/clustered-locks.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
      })
      fs.writeFileSync(fixture, result.outputFiles[0].contents)
      child = fork(fixture, [path.join(root, 'package.json')], {
        execArgv: [],
        env: { ...process.env, LOCK_TEST_ID: randomUUID(), LOCK_TEST_NO_BOOTSTRAP: noBootstrap ? '1' : '0' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
      const completed = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Clustered lock fixture timed out')), 10_000)
        child!.on('message', (message: any) => {
          if (message?.kind === 'done') {
            clearTimeout(timer)
            resolve(true)
          }
          if (message?.kind === 'failed') {
            clearTimeout(timer)
            reject(new Error(message.error))
          }
        })
        child!.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child!.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`Fixture exited before completion: ${code}`))
        })
      })
      expect(completed).toBe(true)
    } finally {
      if (child && child.exitCode === null) {
        const exit = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
        child.kill()
        await exit
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
