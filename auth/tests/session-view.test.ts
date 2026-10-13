import { describe, expect, it } from "vitest";
import { sessionBody } from "../src/sessionView.js";

const HOSTS = ["googleusercontent.com", "cdn.discordapp.com"];
const user = (image: string | null) => ({
  user: { id: "u1", name: "N", email: "n@example.test", image },
});

describe("sessionBody", () => {
  it("answers a signed-out request with no profile fields", () => {
    expect(sessionBody(null, HOSTS)).toEqual({ signedIn: false, userId: null });
  });

  it("passes pictures on a provider image host", () => {
    for (const image of [
      "https://lh3.googleusercontent.com/a/fake-owner",
      "https://cdn.discordapp.com/avatars/1/2.png",
    ])
      expect(sessionBody(user(image), HOSTS)).toMatchObject({ image });
  });

  it("drops non-https, foreign, look-alike and malformed pictures", () => {
    for (const image of [
      "http://lh3.googleusercontent.com/a/x",
      "https://evil.example/a.png",
      "https://evilgoogleusercontent.com/a.png",
      "https://googleusercontent.com.evil.example/a.png",
      "not a url",
      "",
    ])
      expect(sessionBody(user(image), HOSTS)).toMatchObject({ image: null });
  });
});
