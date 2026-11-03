import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('ships the sandbox SDK without bundling host-provided packages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'auto-review-package-'))
  try {
    execFileSync('pnpm', ['pack', '--ignore-scripts', '--pack-destination', directory], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'pipe',
    })
    const archives = readdirSync(directory)
    expect(archives).toStrictEqual([expect.stringMatching(/\.tgz$/)])
    const archive = archives[0]
    if (archive === undefined) {
      throw new Error('The package archive was not created')
    }
    const files = execFileSync('tar', ['-tzf', join(directory, archive)], { encoding: 'utf8' })
      .trim()
      .split('\n')
    const packageFiles = files
      .filter(
        file =>
          file.startsWith('package/node_modules/') &&
          (file.endsWith('/package.json') ||
            /^package\/node_modules\/pi-bring-your-own-sandbox\/src\/(?:api|contracts|pi-tools|testing)\.ts$/.test(
              file,
            )),
      )
      .toSorted()

    expect(packageFiles).toStrictEqual([
      'package/node_modules/pi-bring-your-own-sandbox/package.json',
      'package/node_modules/pi-bring-your-own-sandbox/src/api.ts',
      'package/node_modules/pi-bring-your-own-sandbox/src/contracts.ts',
      'package/node_modules/pi-bring-your-own-sandbox/src/pi-tools.ts',
      'package/node_modules/pi-bring-your-own-sandbox/src/testing.ts',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
