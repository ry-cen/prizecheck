import { describe, expect, it } from "vitest";
import { tcgdexArt } from "./tcgdexArt";

describe("tcgdexArt", () => {
  it("keeps TCGdex art", () => {
    const url = "https://assets.tcgdex.net/en/sv/sv01/001/low.webp";
    expect(tcgdexArt(url)).toBe(url);
  });

  it("drops art from other hosts so the placeholder shows", () => {
    expect(
      tcgdexArt("https://tcgplayer-cdn.tcgplayer.com/product/1_200w.jpg")
    ).toBeNull();
    expect(tcgdexArt("https://evil-tcgdex.net.example.com/a.png")).toBeNull();
    expect(tcgdexArt("https://nottcgdex.net/a.png")).toBeNull();
  });

  it("drops missing and malformed URLs", () => {
    expect(tcgdexArt(null)).toBeNull();
    expect(tcgdexArt("")).toBeNull();
    expect(tcgdexArt("not a url")).toBeNull();
  });
});
