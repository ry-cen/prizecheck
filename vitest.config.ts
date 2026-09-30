import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['auth/tests/**/*.test.ts'], testTimeout: 15_000 } });
