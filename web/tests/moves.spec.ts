import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

function mailLines(path: string): string[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

test('copy handles, destination control, and drag perform the same Move', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  execFileSync('.venv/bin/python', ['-c', `from test_catalog_search import promote
promote({'card-1': 'Pikachu'})`], { env: { ...process.env, PYTHONPATH: 'api:api/tests' } });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DELETE FROM auth_send_event');
  const source = `Source ${randomUUID().slice(0, 8)}`;
  const destination = `Move ${randomUUID().slice(0, 8)}`;
  try {
    await page.goto('http://localhost:5173/locations');
    const mailFile = process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail';
    const beforeSignIn = mailLines(mailFile).length;
    await page.getByLabel('Email').fill(process.env.OWNER_EMAIL || 'owner@example.test');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('status')).toContainText('code has been sent');
    await expect.poll(() => mailLines(mailFile).length).toBeGreaterThan(beforeSignIn);
    await page.getByLabel('Six-digit code').fill(JSON.parse(mailLines(mailFile).at(-1)!).otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'New top-level Location' }).click();
    await page.getByLabel('Name').fill(source);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'New top-level Location' }).click();
    await page.getByLabel('Name').fill(destination);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('navigation', { name: 'Location tree' }).getByRole('button', { name: source }).click();
    const panel = page.getByRole('region', { name: `Cards in ${source}` });
    await panel.getByRole('button', { name: 'Add cards' }).click();
    await panel.getByLabel('Search English card name').fill('Pika');
    await panel.getByRole('button', { name: 'Search' }).click();
    await panel.getByLabel('Card Edition').selectOption({ label: 'Pikachu · Fixture Set #1 · finish: normal' });
    await panel.getByLabel('Quantity').fill('3');
    await panel.getByRole('button', { name: 'Add to Location' }).click();

    const selection = page.getByRole('region', { name: 'Move cards' });
    await selection.getByRole('button', { name: 'Fan copies' }).click();
    await selection.getByRole('button', { name: 'Select 2 Pikachu copies' }).click();
    await expect(selection).toContainText('2 copies · 1 Editions selected');
    await selection.getByRole('button', { name: 'Move selected' }).click();
    await page.getByRole('dialog', { name: 'Choose Move destination' }).getByRole('button', { name: destination }).click();
    await expect(selection.getByRole('status')).toContainText('Moved 2 copies');
    await expect(panel.locator('.holding-stack')).toContainText('×1');

    await selection.getByRole('button', { name: 'Select stack' }).click();
    const selectedRow = await pool.query(`SELECT l.id AS location_id,h.edition_id FROM location l
      JOIN holding h ON h.location_id=l.id WHERE l.name=$1 LIMIT 1`, [source]);
    await pool.query(`WITH changed AS (
      UPDATE inventory_owner SET revision=revision+1
      WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
    ) UPDATE holding SET quantity=quantity+1,version=(SELECT revision FROM changed)
      WHERE location_id=$1 AND edition_id=$2`,
      [selectedRow.rows[0].location_id, selectedRow.rows[0].edition_id]);
    await selection.getByRole('button', { name: 'Move selected' }).click();
    await page.getByRole('dialog', { name: 'Choose Move destination' }).getByRole('button', { name: destination }).click();
    await expect(selection.getByRole('status')).toContainText('selection is saved');
    await selection.getByRole('button', { name: 'Refresh selection' }).click();
    await expect(selection.getByRole('status')).toContainText('Editions refreshed');
    await expect(selection).toContainText('1 copies · 1 Editions selected');
    const dragHandle = selection.getByRole('button', { name: 'Drag selected Pikachu stack' });
    const dropTarget = page.getByRole('navigation', { name: 'Location tree' }).getByRole('button', { name: destination });
    await dragHandle.scrollIntoViewIfNeeded();
    await dropTarget.scrollIntoViewIfNeeded();
    const from = await dragHandle.boundingBox();
    const to = await dropTarget.boundingBox();
    if (!from || !to) throw new Error('Move drag controls are not visible');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(selection.getByRole('status')).toContainText('Moved 1 copies');
    await expect(panel.locator('.holding-stack')).toContainText('×1');
  } finally { await pool.end(); }
});
