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
            /^package\/node_modules\/pi-bring-your-own-sandbox\/dist\/(?:(?:consumer|embedding-host|pi-tools|provider|testing)\.(?:js|d\.ts)|protocol-build\.json)$/.test(
              file,
            )),
      )
      .toSorted()

    expect(packageFiles).toStrictEqual([
      'package/node_modules/ignore/package.json',
      'package/node_modules/pi-bring-your-own-sandbox/dist/consumer.d.ts',
      'package/node_modules/pi-bring-your-own-sandbox/dist/consumer.js',
      'package/node_modules/pi-bring-your-own-sandbox/dist/embedding-host.d.ts',
      'package/node_modules/pi-bring-your-own-sandbox/dist/embedding-host.js',
      'package/node_modules/pi-bring-your-own-sandbox/dist/pi-tools.d.ts',
      'package/node_modules/pi-bring-your-own-sandbox/dist/pi-tools.js',
      'package/node_modules/pi-bring-your-own-sandbox/dist/protocol-build.json',
      'package/node_modules/pi-bring-your-own-sandbox/dist/provider.d.ts',
      'package/node_modules/pi-bring-your-own-sandbox/dist/provider.js',
      'package/node_modules/pi-bring-your-own-sandbox/dist/testing.d.ts',
      'package/node_modules/pi-bring-your-own-sandbox/dist/testing.js',
      'package/node_modules/pi-bring-your-own-sandbox/package.json',
      'package/node_modules/re2js/package.json',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
