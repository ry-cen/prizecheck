import { test,expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

test('owner resolves source drift with evidence and a fresh action-bound email code',async({page})=>{
  execFileSync('.venv/bin/python',['-c',`from test_catalog_search import promote
promote({'reconciliation-1':'Review Pikachu'})`],{env:{...process.env,PYTHONPATH:'api:api/tests'}});
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  await pool.query('DELETE FROM auth_send_event');
  try {
    await page.goto('http://localhost:5173/locations');
    await page.getByLabel('Email',{exact:true}).fill(process.env.OWNER_EMAIL||'owner@example.test');
    await page.getByRole('button',{name:'Send code',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('code has been sent');
    const mail=()=>JSON.parse(readFileSync(process.env.MAIL_FILE!,'utf8').trim().split('\n').at(-1)!).otp as string;
    await page.getByLabel('Six-digit code').fill(mail());await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sign out'})).toBeVisible();
    const user=(await pool.query('SELECT id FROM "user" WHERE email=$1',[process.env.OWNER_EMAIL||'owner@example.test'])).rows[0].id;
    await pool.query('INSERT INTO inventory_owner(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
    await pool.query('INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET user_id=$1',[user]);
    const printing=(await pool.query("SELECT id FROM catalog_printing WHERE source_id='reconciliation-1'")).rows[0].id;
    const review=(await pool.query("INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate) VALUES($1,'reconciliation-1','name_change','browser-review','Incoming name requires physical identity review','{\"name\":\"Different Pikachu\"}') RETURNING id",[printing])).rows[0].id;
    await page.reload();await page.getByRole('button',{name:'Owner controls',exact:true}).click();
    const article=page.getByRole('region',{name:'Catalog reconciliation'}).getByRole('article').filter({hasText:'reconciliation-1'});
    await article.getByLabel('Review reason').fill('Physical card confirms original English name');
    await article.getByLabel('Review evidence URL').fill('https://example.org/card-photo');
    await article.getByRole('button',{name:'Send review code'}).click();
    await expect(article.getByRole('status')).toContainText('Fresh review code sent');
    await article.getByLabel('Fresh review code').fill(mail());
    await article.getByRole('button',{name:'Confirm catalog decision'}).click();
    await expect(article).toHaveCount(0);
    await expect(page.getByRole('region',{name:'Catalog reconciliation'})).not.toContainText('reconciliation-1');
  } finally {await pool.end();}
});
