import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

test('collector adds an exact Edition to a Storage Leaf using keyboard controls', async ({ page }) => {
  execFileSync('.venv/bin/python', ['-c', `from test_catalog_search import promote
promote({'card-1': 'Pikachu'})`], { env: { ...process.env, PYTHONPATH: 'api:api/tests' } });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DELETE FROM auth_send_event');
  try {
    await page.goto('http://localhost:5173/locations');
    await page.getByLabel('Email').fill(process.env.OWNER_EMAIL || 'owner@example.test');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('status')).toContainText('code has been sent');
    const lines = readFileSync(process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail', 'utf8').trim().split('\n');
    await page.getByLabel('Six-digit code').fill(JSON.parse(lines.at(-1)!).otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('navigation', { name: 'Location tree' }).getByRole('button', { name: 'Unsorted' }).click();
    const panel = page.getByRole('region', { name: 'Cards in Unsorted' });
    await panel.getByRole('button', { name: 'Add cards' }).focus();
    await page.keyboard.press('Enter');
    await panel.getByLabel('Search English card name').fill('Pika');
    await panel.getByRole('button', { name: 'Search' }).click();
    await panel.getByLabel('Card Edition').selectOption({ label: 'Pikachu · Fixture Set #1 · finish: normal' });
    await panel.getByLabel('Quantity').fill('3');
    await panel.getByRole('button', { name: 'Add to Location' }).click();
    await expect(panel.getByRole('status')).toContainText('This stack now has 3 copies');
    await expect(panel.locator('.holding-stack')).toHaveCount(1);
    await expect(panel.locator('.holding-stack')).toContainText('×3');
    await panel.getByRole('button', { name: 'Add cards' }).click();
    await panel.getByLabel('Search English card name').fill('Pika');
    await panel.getByRole('button', { name: 'Search' }).click();
    await panel.getByLabel('Card Edition').selectOption({ label: 'Pikachu · Fixture Set #1 · finish: normal' });
    await panel.getByLabel('Quantity').fill('2');
    await panel.getByRole('button', { name: 'Add to Location' }).click();
    await expect(panel.locator('.holding-stack')).toHaveCount(1);
    await expect(panel.locator('.holding-stack')).toContainText('×5');
  } finally { await pool.end(); }
});
