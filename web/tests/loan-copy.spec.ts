// m12 s6 (Opus m11 F8): a Loan says who is borrowing what from whom in one line, says where handed-over cards are now,
// and labels its quantities.
import { test, expect } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  lendHandedOver,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
  ORIGIN,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Loan rows and details read plainly at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize(viewport);
    const ids = seedCatalog();
    const borrower = await collectors.signIn();
    await nameCollector(borrower.page, "Ash K");
    await signInAsOwner(page, "/loans");
    await nameCollector(page, "Misty W");
    await befriend(page, borrower.page);
    await hold(page, await unsorted(page), ids["PAL 185"], 2);
    await borrower.page.setViewportSize(viewport);

    // A request nobody answered yet: its row and its count already read plainly.
    const asked = await api(borrower.page, "POST", "/api/loans", {
      lender_id: await accountId(page),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      idempotency_key: randomUUID(),
    });
    await page.goto(`${ORIGIN}/loans`);
    const needsYou = page.getByRole("region", { name: "Needs you" });
    await expect(needsYou.getByRole("link")).toContainText(
      "Lending 1 Iono to Ash K"
    );
    await loanStep(borrower.page, asked.id, "withdraw");

    const loanId = await lendHandedOver(page, borrower.page, [
      [ids["PAL 185"], 1],
    ]);

    // Borrower: direction, card and Friend in one line, with the card named once.
    await borrower.page.goto(`${ORIGIN}/loans`);
    const out = borrower.page
      .getByRole("region", { name: "Out now" })
      .getByRole("link");
    await expect(out).toHaveCount(1);
    await expect(out).toContainText("Borrowing 1 Iono from Misty W");
    expect(((await out.innerText()).match(/Iono/g) ?? []).length).toBe(1);

    // Lender: the same loan from the other side.
    await page.goto(`${ORIGIN}/loans`);
    const lent = page
      .getByRole("region", { name: "Out now" })
      .getByRole("link");
    await expect(lent).toContainText("Lending 1 Iono to Ash K");
    expect(((await lent.innerText()).match(/Iono/g) ?? []).length).toBe(1);

    // Detail after the handover: where the card is now, and a labelled quantity.
    await borrower.page.goto(`${ORIGIN}/loans/${loanId}`);
    const main = borrower.page.getByRole("main");
    const facts = main.locator("p").filter({ hasText: /^You're borrowing/ });
    await expect(facts).toContainText("You're borrowing · Arrived in Unsorted");
    await expect(facts).not.toContainText("Goes to");
    const cards = main
      .getByRole("list", { name: "Cards", exact: true })
      .getByRole("listitem");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("1 copy");
    expect(
      (await cards.first().innerText()).split("\n").map((l) => l.trim())
    ).not.toContain("1");
  });
}

test("a borrower's own confirmation says the copies arrived, and the lender's alone does not", async ({
  page,
  collectors,
}) => {
  const ids = seedCatalog();
  const borrower = await collectors.signIn();
  await nameCollector(borrower.page, "Ash K");
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Misty W");
  await befriend(page, borrower.page);
  await hold(page, await unsorted(page), ids["PAL 185"], 2);
  const accepted = async () => {
    const sent = await api(borrower.page, "POST", "/api/loans", {
      lender_id: await accountId(page),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      idempotency_key: randomUUID(),
    });
    await loanStep(page, sent.id, "accept", {
      lines: [{ edition_id: ids["PAL 185"], promised: "1" }],
    });
    return sent.id as string;
  };
  const facts = (loanId: string) =>
    borrower.page.goto(`${ORIGIN}/loans/${loanId}`).then(() =>
      borrower.page
        .getByRole("main")
        .locator("p")
        .filter({ hasText: /^You're borrowing/ })
    );

  // The borrower confirms first: the copies are in Unsorted already, though the Loan is still accepted.
  const first = await accepted();
  await loanStep(borrower.page, first, "handover");
  await expect(await facts(first)).toContainText(
    "You're borrowing · Arrived in Unsorted"
  );
  await expect(await facts(first)).not.toContainText("Goes to");

  // Only the lender confirmed: nothing has arrived yet.
  const second = await accepted();
  await loanStep(page, second, "handover");
  await expect(await facts(second)).toContainText(
    "You're borrowing · Goes to Unsorted"
  );
  await expect(await facts(second)).not.toContainText("Arrived");
});
