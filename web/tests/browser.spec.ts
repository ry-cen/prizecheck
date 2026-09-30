import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

test('owner signs in, sees Unsorted, follows safe destination, then signs out', async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DELETE FROM auth_send_event');
  const email = process.env.OWNER_EMAIL || 'owner@example.test';
  await page.goto('http://localhost:5173/locations?next=%2Flocations');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('status')).toContainText('code has been sent');
  const lines = readFileSync(process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail', 'utf8').trim().split('\n');
  const code = JSON.parse(lines.at(-1)!).otp;
  await page.getByLabel('Six-digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unsorted' })).toBeVisible();
  await expect(page).toHaveURL('http://localhost:5173/locations');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unsorted' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
  await pool.end();
});

test('external return destinations are discarded', async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DELETE FROM auth_send_event');
  const email = process.env.OWNER_EMAIL || 'owner@example.test';
  await page.goto('http://localhost:5173/locations?next=https%3A%2F%2Fexample.com%2Fsteal');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('status')).toContainText('code has been sent');
  const lines = readFileSync(process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail', 'utf8').trim().split('\n');
  await page.getByLabel('Six-digit code').fill(JSON.parse(lines.at(-1)!).otp);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('http://localhost:5173/locations');
  await pool.end();
});
