import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

test('collector chooses where stocked leaf cards go and confirms empty Location deletion', async ({ page }) => {
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
    await expect(page.getByRole('navigation', { name: 'Location tree' })).toBeVisible();

    const suffix = Date.now().toString(36);
    const box = `Box ${suffix}`;
    const child = `Page ${suffix}`;
    await page.getByRole('button', { name: 'New top-level Location' }).click();
    await page.locator('.location-form').getByLabel('Name').fill(box);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: box })).toBeVisible();
    const panel = page.getByRole('region', { name: `Cards in ${box}` });
    await panel.getByRole('button', { name: 'Add cards' }).click();
    await panel.getByLabel('Search English card name').fill('Pika');
    await panel.getByRole('button', { name: 'Search' }).click();
    await panel.getByLabel('Card Edition').selectOption({ label: 'Pikachu · Fixture Set #1 · finish: normal' });
    await panel.getByLabel('Quantity').fill('3');
    await panel.getByRole('button', { name: 'Add to Location' }).click();
    await expect(panel.locator('.holding-stack')).toContainText('×3');

    await page.getByRole('button', { name: 'New child' }).click();
    await page.locator('.location-form').getByLabel('Name').fill(child);
    await page.getByRole('button', { name: 'Save' }).click();
    const conversion = page.getByRole('form', { name: 'Convert Storage Leaf' });
    await expect(conversion).toBeVisible();
    await conversion.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: box })).toBeVisible();
    await page.getByRole('button', { name: 'New child' }).click();
    await page.locator('.location-form').getByLabel('Name').fill(child);
    await page.getByRole('button', { name: 'Save' }).click();
    await conversion.getByLabel(`Move cards into ${child}`).check();
    await conversion.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: child })).toBeVisible();
    await expect(page.getByRole('region', { name: `Cards in ${child}` }).locator('.holding-stack')).toContainText('×3');

    const empty = `Empty ${suffix}`;
    await page.getByRole('button', { name: 'New top-level Location' }).click();
    await page.locator('.location-form').getByLabel('Name').fill(empty);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Delete Location' }).click();
    const deletion = page.getByRole('form', { name: 'Delete Location' });
    await deletion.getByLabel(`Type ${empty} to confirm`).fill(empty);
    await deletion.getByRole('button', { name: 'Delete Location' }).click();
    await expect(page.getByRole('navigation', { name: 'Location tree' }).getByRole('button', { name: empty })).toHaveCount(0);
  } finally { await pool.end(); }
});
