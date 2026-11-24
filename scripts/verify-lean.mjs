import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const leanDir = path.join(root, 'formal', 'lean')

const elanBin = path.join(os.homedir(), '.elan', 'bin')
const envPath = fs.existsSync(elanBin) ? `${elanBin}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH || ''

const result = spawnSync('lake', ['build'], {
  cwd: leanDir,
  env: { ...process.env, PATH: envPath },
  stdio: 'inherit',
})

if (result.error) {
  console.error('Lean 4 / lake not found. Install elan (https://github.com/leanprover/elan) and retry.')
  process.exit(1)
}
process.exit(result.status ?? 1)
