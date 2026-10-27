# Provider marks

The sign-in buttons and the Settings Sign-ins rows show each company's own mark (sign-in decision,
`docs/planning/app-redesign/wayfinder/resolutions/decide-sign-in-and-loading.md`). Both files were downloaded on
2026-10-26. They are the companies' trademarks, used only to label signing in with that company, not PrizeCheck's to
license.

## google-g.svg

- Source: `signin-assets.zip` from Google's sign-in branding guidelines,
  <https://developers.google.com/identity/branding-guidelines>, file
  `Android + Web/SVG/Dark/Theme=Dark, Show text=No, Shape=Square, Platform=Android+Web.svg`.
- Changes: the button's own background and stroke are removed and the view box is cropped to the G (10 10 20 20), so
  it sits on our button, which already draws Google's dark-theme fill and stroke (`--brand-google*` in `tokens.css`).
  Figma's export metadata attributes are dropped. The G's paths, gradient, mask and filters are untouched.
- Terms: Google's guidelines require the standard-colour G, unmodified, on a button that follows their light, dark or
  neutral theme, with the text "Sign in with Google", "Sign up with Google" or "Continue with Google".

## discord-mark-white.svg

- Source: the white symbol SVG from Discord's brand page, <https://discord.com/branding>
  (`Discord_Symbol_White/Discord-Symbol-White.svg`), byte for byte.
- Terms: Discord's brand guidelines allow the symbol in white, black or blurple, unmodified, with clear space around it;
  ours is white on blurple `#5865F2` (`--brand-discord`).

Replace a file only with a fresh download from the same page, and update this note.
