import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('workflow and local-service security', () => {
  it('keeps Pages and OIDC authority out of the pull-request coverage job', () => {
    const workflow = read('.github/workflows/coverage.yml')
    const header = workflow.slice(0, workflow.indexOf('\njobs:'))
    const pagesJob = workflow.slice(workflow.indexOf('\n  pages:'))

    expect(header).toContain('permissions:\n  contents: read')
    expect(header).not.toContain('pages: write')
    expect(header).not.toContain('id-token: write')
    expect(pagesJob).toContain('permissions:\n      contents: read\n      pages: write\n      id-token: write')
  })

  it('exposes the Codecov token only to the non-PR upload step', () => {
    const workflow = read('.github/workflows/coverage.yml')
    const job = workflow.slice(workflow.indexOf('\n  doublcov:'), workflow.indexOf('\n  pages:'))

    expect(job).not.toMatch(/runs-on:[\s\S]*?\n    env:\n      CODECOV_TOKEN:/)
    expect(job).toContain("if: github.event_name != 'pull_request' && env.CODECOV_TOKEN != ''")
    expect(job).toMatch(/- name: Upload Codecov report[\s\S]*?env:\n          CODECOV_TOKEN: \$\{\{ secrets\.CODECOV_TOKEN \}\}/)
  })

  it('publishes the local Redis port on loopback only', () => {
    expect(read('docker-compose.yml')).toContain("- '127.0.0.1:6379:6379'")
  })
})
