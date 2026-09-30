import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './web/tests', workers: 1, use: { browserName: 'chromium', headless: true }, reporter: 'list' });
