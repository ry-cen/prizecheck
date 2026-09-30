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

test('bound owner starts one catalog run from the private panel', async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DELETE FROM auth_send_event');
  await pool.query('DELETE FROM owner_binding');
  await pool.query("UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now() WHERE outcome IS NULL");
  const email = process.env.OWNER_EMAIL || 'owner@example.test';
  await page.goto('http://localhost:5173/locations');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('status')).toContainText('code has been sent');
  const lines = readFileSync(process.env.MAIL_FILE || '/tmp/tcg-ticket01-mail', 'utf8').trim().split('\n');
  await page.getByLabel('Six-digit code').fill(JSON.parse(lines.at(-1)!).otp);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Owner controls' })).toHaveCount(0);
  const result = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
  await pool.query('INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1)', [result.rows[0].id]);
  await page.reload();
  await page.getByRole('button', { name: 'Owner controls' }).click();
  await expect(page.getByRole('heading', { name: 'English catalog pull' })).toBeVisible();
  await page.getByRole('button', { name: 'Start full English pull' }).click();
  await expect(page.getByText('Phase: queued')).toBeVisible();
  expect((await pool.query('SELECT count(*) AS n FROM catalog_run WHERE outcome IS NULL')).rows[0].n).toBe('1');
  await pool.query("UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now() WHERE outcome IS NULL");
  await pool.end();
});
