import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("owner resolves source drift with evidence and a fresh action-bound email code", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'reconciliation-1':'Review Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  try {
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await page
      .getByLabel("Email", { exact: true })
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("code has been sent");
    const mail = () =>
      JSON.parse(
        readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
      ).otp as string;
    await page.getByLabel("Six-digit code").fill(mail());
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    const user = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [
        process.env.OWNER_EMAIL || "owner@example.test",
      ])
    ).rows[0].id;
    await pool.query(
      "INSERT INTO inventory_owner(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [user]
    );
    await pool.query(
      "INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET user_id=$1",
      [user]
    );
    const printing = (
      await pool.query(
        "SELECT id FROM catalog_printing WHERE source_id='reconciliation-1'"
      )
    ).rows[0].id;
    const review = (
      await pool.query(
        "INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate) VALUES($1,'reconciliation-1','name_change','browser-review','Incoming name requires physical identity review','{\"name\":\"Different Pikachu\"}') RETURNING id",
        [printing]
      )
    ).rows[0].id;
    await page.reload();
    await page
      .getByRole("button", { name: "Owner controls", exact: true })
      .click();
    const article = page
      .getByRole("region", { name: "Catalog reconciliation" })
      .getByRole("article")
      .filter({ hasText: "reconciliation-1" });
    await article
      .getByLabel("Review reason")
      .fill("Physical card confirms original English name");
    await article
      .getByLabel("Review evidence URL")
      .fill("https://example.org/card-photo");
    // Sign-in and catalog approval share the one-email-per-minute limit.
    await pool.query("UPDATE auth_send_event SET sent_at=now()");
    const limited = page.waitForResponse((r) =>
      r.url().endsWith("/auth/approval-code")
    );
    await article.getByRole("button", { name: "Send review code" }).click();
    expect((await limited).status()).toBe(429);
    await expect(article.getByRole("status")).toContainText(
      "Unable to send review code"
    );
    await pool.query(
      "UPDATE auth_send_event SET sent_at=now()-interval '61 seconds'"
    );
    await article.getByRole("button", { name: "Send review code" }).click();
    await expect(article.getByRole("status")).toContainText(
      "Fresh review code sent"
    );
    await article.getByLabel("Fresh review code").fill(mail());
    await article
      .getByRole("button", { name: "Confirm catalog decision" })
      .click();
    await expect(article).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Catalog reconciliation" })
    ).not.toContainText("reconciliation-1");
  } finally {
    await pool.end();
  }
});

test("collector explicitly confirms reviewed Edition reassignment without changing total copies", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'card-1':'Correction Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  const location = `Correction ${Date.now()}`;
  try {
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await page
      .getByLabel("Email", { exact: true })
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("code has been sent");
    const mail = () =>
      JSON.parse(
        readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
      ).otp as string;
    await page.getByLabel("Six-digit code").fill(mail());
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "New top-level Location" }).click();
    await page.getByLabel("Name", { exact: true }).fill(location);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Location tree" })
      .getByRole("button", { name: location, exact: true })
      .click();
    const panel = page.getByRole("region", { name: `Cards in ${location}` });
    await panel.getByRole("button", { name: "Add cards" }).click();
    await panel.getByLabel("Search English card name").fill("Correction");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel.getByLabel("Card Edition").selectOption({
      label: "Correction Pikachu · Fixture Set #1 · finish: normal",
    });
    await panel.getByLabel("Quantity", { exact: true }).fill("4");
    await panel.getByRole("button", { name: "Add to Location" }).click();
    await expect(panel.locator(".holding-stack")).toContainText("×4");
    // Catalog imports are fixture work; observations go through the real gateway.
    const refresh = (amount: string, onlineCode = "FIXTURE") =>
      execFileSync(
        ".venv/bin/python",
        [
          "-c",
          `from test_catalog_search import SearchSource
from test_catalog_reconciliation import run
class MetadataSource(SearchSource):
    def fetch(self, sid):
        card = super().fetch(sid)
        card['name'] = 'Incoming physical discrepancy'
        card['pricing'] = {'tcgplayer': {'normal': {'marketPrice': ${amount}}}}
        card['thirdParty'] = {'tcgplayer': '12345'}
        card['set']['tcgOnline'] = '${onlineCode}'
        return card
run(MetadataSource({'card-1': 'Correction Pikachu'}))`,
        ],
        { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
      );
    await pool.query(
      'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
      [process.env.OWNER_EMAIL || "owner@example.test"]
    );
    const gateway = (path: string) => new URL(path, page.url()).href;
    const sameOrigin = { origin: new URL(page.url()).origin };
    const queue = async () => {
      const response = await page.request.get(
        gateway("/api/admin/catalog-reviews")
      );
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    // Published Deck references are checked through the gateway across imports.
    const deck = await page.request.post(gateway("/api/decks"), {
      headers: sameOrigin,
      data: { name: `Published ${location}`, idempotency_key: randomUUID() },
    });
    expect(deck.status()).toBe(201);
    const deckId = (await deck.json()).location.id;
    const normalEdition = (
      await pool.query(
        "SELECT e.id,e.public_ref,p.public_ref AS printing_ref FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='card-1' AND e.descriptor->>'finish'='normal'"
      )
    ).rows[0];
    expect(
      (
        await page.request.post(gateway("/api/holdings"), {
          headers: sameOrigin,
          data: {
            location_id: deckId,
            edition_id: normalEdition.id,
            quantity: "3",
            idempotency_key: randomUUID(),
          },
        })
      ).status()
    ).toBe(200);
    const published = await page.request.post(
      gateway(`/api/decks/${deckId}/publication`),
      {
        headers: sameOrigin,
        data: { title: "Reference check", idempotency_key: randomUUID() },
      }
    );
    expect(published.status()).toBe(200);
    const publicPath = gateway(
      `/api/public/decks/${(await published.json()).token}`
    );
    const snapshot = await (await page.request.get(publicPath)).json();
    expect(snapshot.identities[0].editions[0]).toMatchObject({
      edition_ref: normalEdition.public_ref,
      printing_ref: normalEdition.printing_ref,
    });
    refresh("0.25");
    const firstQueue = await queue();
    expect(firstQueue).toHaveLength(1);
    // Quote-only refreshes neither add reviews nor change the evidence shown.
    refresh("0.43");
    expect(await queue()).toEqual(firstQueue);
    // Model a pending review made by the historical raw-fingerprint importer.
    await pool.query(
      "UPDATE catalog_review SET source_fingerprint='legacy-raw-evidence',candidate=candidate-'metadata' WHERE source_id='card-1' AND kind='name_change'"
    );
    const pendingBefore = await queue();
    refresh("0.43", "UPDATED");
    const queueAfter = await queue();
    expect(queueAfter.map((row: { id: string }) => row.id)).toEqual(
      pendingBefore.map((row: { id: string }) => row.id)
    );
    const latestReview = queueAfter[0];
    // Legacy evidence is backfilled once; quote payloads never enter review evidence.
    expect(latestReview.candidate.metadata.export_candidate.set.tcgOnline).toBe(
      "UPDATED"
    );
    expect(
      latestReview.candidate.metadata.source_record.pricing
    ).toBeUndefined();
    expect(latestReview.evidence_digest).not.toBe(
      pendingBefore[0].evidence_digest
    );
    // The owner decides through the gateway with a fresh code bound to the evidence shown.
    await pool.query(
      "UPDATE auth_send_event SET sent_at=now()-interval '61 seconds'"
    );
    const sent = await page.request.post(gateway("/auth/approval-code"), {
      headers: sameOrigin,
      data: { reviewId: latestReview.id, action: "resolve_catalog" },
    });
    expect(sent.ok()).toBeTruthy();
    const decision = {
      decision: "keep_existing",
      reason: "Physical card confirms the established name",
      evidence_url: "https://example.org/card-photo",
      code: mail(),
    };
    const decide = (digest: string) =>
      page.request.post(
        gateway(`/api/admin/catalog-reviews/${latestReview.id}/decision`),
        { headers: sameOrigin, data: { ...decision, evidence_digest: digest } }
      );
    const stale = await decide(pendingBefore[0].evidence_digest);
    expect(stale.status()).toBe(409);
    expect((await stale.json()).detail.code).toBe("REVIEW_EVIDENCE_CHANGED");
    const retained = await decide(latestReview.evidence_digest);
    expect(retained.status()).toBe(200);
    const decided = await retained.json();
    expect(decided.status).toBe("retained");
    refresh("0.99", "UPDATED");
    expect(await queue()).toEqual([]);
    const provenance = (
      await pool.query(
        "SELECT status,candidate,reviewer_id FROM catalog_review WHERE id=$1",
        [latestReview.id]
      )
    ).rows[0];
    expect(provenance.status).toBe("retained");
    expect(provenance.candidate).toEqual(decided.candidate);
    expect(provenance.reviewer_id).toBeTruthy();
    const catalogBefore = await page.request.get(
      new URL("/api/catalog/search?name=Correction", page.url()).href
    );
    const priorEditions = (await catalogBefore.json()).printings[0].editions;
    execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `from test_catalog_search import SearchSource
from test_catalog_reconciliation import run
class AmbiguousSource(SearchSource):
    def fetch(self, sid):
        card = super().fetch(sid)
        card['name'] = 'Incoming physical discrepancy'
        card['variants_detailed'] = [
            {'finish': 'normal', 'thirdParty': {'tcgplayer': 1}, 'unclassifiedFacet': 'one'},
            {'finish': 'normal', 'thirdParty': {'tcgplayer': 2}, 'unclassifiedFacet': 'two'}]
        return card
run(AmbiguousSource({'card-1': 'Correction Pikachu', 'card-2': 'Unknown facets'}))`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    const catalogAfter = await page.request.get(
      new URL("/api/catalog/search?name=Correction", page.url()).href
    );
    expect((await catalogAfter.json()).printings[0].editions).toEqual(
      priorEditions
    );
    const unknownPrinting = await page.request.get(
      new URL("/api/catalog/search?name=Incoming", page.url()).href
    );
    expect(
      (await unknownPrinting.json()).printings[0].editions.map(
        (row: { descriptor: unknown }) => row.descriptor
      )
    ).toEqual([{ kind: "unspecified", label: "Unspecified Variant" }]);
    const physicalQueue = await page.request.get(
      new URL("/api/admin/catalog-reviews", page.url()).href
    );
    const ambiguity = (await physicalQueue.json()).find(
      (row: { kind: string }) => row.kind === "variant_ambiguity"
    );
    expect(ambiguity.candidate.metadata.unknown_fields.variants).toEqual([
      { unclassifiedFacet: "one" },
      { unclassifiedFacet: "two" },
    ]);
    // Quote, target-metadata and ambiguous imports leave the frozen public references intact.
    expect(await (await page.request.get(publicPath)).json()).toEqual(snapshot);
    expect(
      (
        await pool.query(
          "SELECT id,public_ref FROM catalog_edition WHERE id=$1",
          [normalEdition.id]
        )
      ).rows[0].public_ref
    ).toBe(normalEdition.public_ref);
    await page.reload();
    await page
      .getByRole("navigation", { name: "Location tree" })
      .getByRole("button", { name: location, exact: true })
      .click();
    await expect(panel.locator(".holding-stack")).toHaveCount(1);
    await expect(panel.locator(".holding-stack")).toContainText(
      "Correction Pikachu"
    );
    await expect(panel.locator(".holding-stack")).toContainText("×4");
    const editions = (
      await pool.query(
        "SELECT e.id,e.descriptor->>'finish' AS finish,p.id AS printing FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='card-1'"
      )
    ).rows;
    const original = editions.find((e) => e.finish === "normal")!,
      replacement = editions.find((e) => e.finish === "reverse")!;
    const owner = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [
        process.env.OWNER_EMAIL || "owner@example.test",
      ])
    ).rows[0].id;
    const review = (
      await pool.query(
        "INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,status) VALUES($1,'card-1','variant_ambiguity','browser-correction','Physical finish corrected','corrected') RETURNING id",
        [original.printing]
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO catalog_edition_replacement(edition_id,replacement_edition_id,review_id,reviewer_id,evidence_url,reason) VALUES($1,$2,$3,$4,'https://example.org/foil','Physical foil evidence supports reverse finish')",
      [original.id, replacement.id, review, owner]
    );
    await pool.query(
      "UPDATE catalog_generation_edition SET active=false WHERE edition_id=$1",
      [original.id]
    );
    await page.reload();
    await page
      .getByRole("navigation", { name: "Location tree" })
      .getByRole("button", { name: location, exact: true })
      .click();
    const correction = page.getByRole("region", {
      name: "Reviewed Edition corrections",
    });
    await expect(correction).toContainText(
      "Your 4 copies still use the original Edition"
    );
    await correction.getByLabel("Copies to reassign").fill("2");
    await correction
      .getByRole("button", { name: "Review reassignment" })
      .click();
    await expect(correction).toContainText(
      "Reassign 2 copies to the reviewed replacement"
    );
    await correction
      .getByRole("button", { name: "Confirm reassignment" })
      .click();
    await expect(panel.locator(".holding-stack")).toHaveCount(2);
    await expect(panel.locator(".holding-stack").nth(0)).toContainText("×2");
    await expect(panel.locator(".holding-stack").nth(1)).toContainText("×2");
    await expect(correction).toContainText(
      "Your 2 copies still use the original Edition"
    );
  } finally {
    await pool.end();
  }
});
