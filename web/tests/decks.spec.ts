import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

function messages(path: string): string[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

test('physical Deck creation, actual Holdings checks, and Move out', async ({ page }) => {
  execFileSync('.venv/bin/python', ['-c', `from test_catalog_search import promote
promote({'card-1': 'Pikachu'})`], { env: { ...process.env, PYTHONPATH: 'api:api/tests' } });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('DELETE FROM auth_send_event');
    const mail = process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail';
    const before = messages(mail).length;
    await page.goto('http://localhost:5173/locations');
    await page.getByLabel('Email').fill(process.env.OWNER_EMAIL || 'owner@example.test');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
    await page.getByLabel('Six-digit code').fill(JSON.parse(messages(mail).at(-1)!).otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Decks', exact: true }).click();
    const name = `Deck ${randomUUID().slice(0, 8)}`;
    await page.getByLabel('Deck name').fill(name);
    await page.getByRole('button', { name: 'Create Deck', exact: true }).click();
    const checks = page.getByRole('region', { name: `Checks for ${name}` });
    await expect(checks).toContainText('0 cards · 60 cards short of 60');
    await expect(checks).toContainText('Standard eligibility, rotation, bans, and special card rules are not evaluated.');
    const holdings = page.getByRole('region', { name: `Cards in ${name}` });
    await holdings.getByRole('button', { name: 'Add cards', exact: true }).click();
    await holdings.getByLabel('Search English card name').fill('Pika');
    await holdings.getByRole('button', { name: 'Search', exact: true }).click();
    await holdings.getByLabel('Card Edition').selectOption({ label: 'Pikachu · Fixture Set #1 · finish: normal' });
    await holdings.getByLabel('Quantity', { exact: true }).fill('61');
    await holdings.getByRole('button', { name: 'Add to Location', exact: true }).click();
    await expect(checks).toContainText('61 cards · 1 cards over 60');
    await expect(checks).toContainText('Over four-copy limit');
    const move = holdings.getByRole('region', { name: 'Move cards' });
    await move.getByRole('button', { name: 'Fan copies', exact: true }).click();
    await move.getByRole('button', { name: 'Select 2 Pikachu copies', exact: true }).click();
    await move.getByRole('button', { name: 'Move selected', exact: true }).click();
    await page.getByRole('dialog', { name: 'Choose Move destination' }).getByRole('button', { name: 'Unsorted', exact: true }).click();
    await expect(checks).toContainText('59 cards · 1 cards short of 60');
    await page.getByRole('button', { name: 'Locations', exact: true }).click();
    await page.getByRole('navigation', { name: 'Location tree' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('region', { name: `Cards in ${name}` })).toContainText('×59');
  } finally { await pool.end(); }
});
