import type { ViteUserConfig } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['test-live/**/*.live.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    hookTimeout: 30_000,
  },
})

export default config
