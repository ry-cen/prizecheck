import { test, expect } from "@playwright/test";
import { variantLabel } from "../src/ui/variantLabel";

// A live TCGdex variant carries its marketplace IDs in the Edition descriptor; the Variant reads only the
// physical keys.
test("the Variant leaves out the marketplace IDs a TCGdex descriptor carries", () => {
  expect(
    variantLabel({
      type: "holo",
      size: "standard",
      thirdParty: { tcgplayer: 704805, cardmarket: 895788 },
    })
  ).toBe("Holo");
  expect(
    variantLabel({
      type: "normal",
      variantId: "n",
      tcgplayer: { productId: 7 },
    })
  ).toBe("Normal");
  expect(variantLabel({ thirdParty: { tcgplayer: 1 } })).toBe(
    "Unspecified Variant"
  );
  expect(variantLabel({ type: "normal", stamps: ["first-edition"] })).toBe(
    "Normal, First Edition"
  );
});
