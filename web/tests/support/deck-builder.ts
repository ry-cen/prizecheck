import { expect, type Page } from "@playwright/test";

/**
 * The deck builder's exports (#181): Export in the page header opens one "Export" dialog on Pokémon TCG Live; its
 * "Export to" choice switches to TCGplayer Mass Entry, whose "Send to TCGplayer" choice picks the cards you don't own
 * or the whole Deck List. Buy missing (header row 1) opens it on Mass Entry with the cards you don't own.
 *
 * Opens the export of `kind` from the builder at /decks/<id> and returns its panel region: "Pokémon TCG Live export"
 * or "TCGplayer export". For Mass Entry, `scope` picks the copies (default: the whole Deck List, which the specs written
 * before #181 export).
 */
export async function openExport(
  page: Page,
  kind: "live" | "mass",
  scope: "deck_list" | "not_owned" = "deck_list"
) {
  await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  if (kind === "live")
    return dialog.getByRole("region", { name: "Pokémon TCG Live export" });
  await dialog.getByRole("radio", { name: "TCGplayer Mass Entry" }).click();
  await dialog
    .getByRole("radio", {
      name:
        scope === "deck_list" ? /^The whole Deck List/ : /^Cards you don't own/,
    })
    .check();
  return dialog.getByRole("region", { name: "TCGplayer export", exact: true });
}

/** The export dialog's own page region, for closing it or checking what surrounds the panel. */
export const exportDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Export" });
