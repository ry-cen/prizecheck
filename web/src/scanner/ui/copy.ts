// Every collector-facing string of the scanner screen. The final wording is the spec's "Copy" table (owner-approved
// 2026-10-25); lines marked "prototype" come from the scan-tray prototype the owner reviewed; lines marked "new" were
// written for this screen and wait for the owner's eye. No source, index, download or asset wording belongs here.

// Spec "Copy" table.
export const GETTING_READY = "Getting the scanner ready";
export const CANNOT_START = "The scanner can't start";
export const HINT_DARK = "More light";
export const HINT_BRIGHT = "Less light";
export const HINT_GLARE = "Tilt to avoid glare";
export const HINT_SOFT = "Hold steady";
export const HINT_UNRESOLVED =
  "Couldn't add this card. Tap the shutter to search.";
export const HINT_OFFLINE =
  "Can't reach PrizeCheck. Check your connection and scan again.";
export const HINT_EDITION_LIMIT =
  "That's the most copies of one card in a tray";
export const TRAY_FULL =
  "The tray is full. Add these cards to your Collection before scanning more.";
export const STALE_SAVE_NOTE =
  "This tray may already be in your Collection. Check before confirming again.";
export const staleBanner = (n: number) =>
  `${n} ${n === 1 ? "row needs" : "rows need"} a finish before you can add ${n === 1 ? "it" : "them"}.`;
export const staleFooter = (n: number) =>
  `${n} ${n === 1 ? "row needs" : "rows need"} a finish.`;
export const cardsText = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`;
export const confirmLabel = (n: number, where: string) =>
  `Add ${cardsText(n)} to ${where}`;
export const addedToast = (copies: string, where: string) =>
  `Added ${copies} ${copies === "1" ? "card" : "cards"} to ${where}`;

// Prototype.
export const SHOW = "Show";
export const CLOSE_SCANNER = "Close scanner";
export const LOCK_SOUND = "Lock sound";
export const SHUTTER = "Scan this card";
export const TRAY = "Tray";
export const REVIEW = "Review";
export const KEEP_SCANNING = "Keep scanning";
export const PUT_CARDS_IN = "Put cards in";
export const CHANGE_CARD = "Change card";
export const CLEAR_TRAY = "Clear tray";
export const KEEP_CARDS = "Keep cards";
export const NOT_NOW = "Not now";
export const REVIEW_TRAY = "Review tray";
export const EMPTY_PEEK = "Cards you scan wait here until you add them.";
export const EMPTY_TRAY =
  "The tray is empty. Cards you scan wait here until you add them.";
export const PICK_A_FINISH = "Pick a finish";
export const GONE_FROM_CATALOG =
  "This card isn't in the catalog anymore. Search for it or remove it.";
export const finishGone = (finish: string) =>
  `${finish} isn't listed for this card anymore. Pick its finish again.`;
export const OFFLINE_LINE = "You're offline. Reconnect to add these cards.";
export const LOCKED_LINE = "The tray is locked until this finishes.";
export const NOT_FINISHED_LINE =
  "The save didn't finish. Try again; your cards won't be added twice.";
export const EDITIONS_NOTE =
  "Nothing was added yet. Pick a finish for the marked cards, then add them.";
export const DESTINATION_NOTE =
  "Choose where to put these cards. Nothing was added yet.";
export const DESTINATION_HELP =
  "Everything goes here. You can sort cards into other Locations afterwards.";
export const clearBody = (n: number) =>
  `This removes ${cardsText(n)} from the tray. Nothing in your Collection changes.`;
export const SEARCH_TITLE = "Find this card";
export const SEARCH_MISS =
  "This card wasn't recognized. Search for it to add it to the tray.";
export const SEARCH_PLACEHOLDER = "Name, or set code and number";
export const SEARCH_UNAVAILABLE = "Search isn't available right now.";
export const NO_MATCHES = "No matches.";
export const BACK_TO_SCANNING = "Back to scanning";
export const REMOVE_FROM_TRAY = "Remove from tray";
export const SEARCH_FOR_CARDS = "Search for cards";
export const IMPORT_ELSEWHERE = "Import from another tracker";
export const TRY_AGAIN = "Try again";
export const GENERIC_CAUSE =
  "You can still add cards by searching for them or importing them from another tracker.";
export const HOW_TO_ALLOW = "How to allow the camera";
export const HOW_TO_ALLOW_IOS =
  "On iPhone: open Settings, then Apps, then Safari, then Camera, and choose Ask or Allow. Then come back and tap Try again.";
export const HOW_TO_ALLOW_ANDROID =
  "On Android: in Chrome, tap the icon to the left of the web address, then Permissions, and turn on Camera.";
export const trayStill = (n: number) => `Your tray still has ${cardsText(n)}.`;

// New: not in the spec table or the prototype.
export const CAUSE_DENIED = "The camera is blocked for PrizeCheck.";
export const CAUSE_NO_CAMERA = "This device has no camera the scanner can use.";
export const CAUSE_UNSUPPORTED = "This browser can't run the scanner.";
export const RETRY = "Retry";
export const PAUSED_STRIP = "Scanning paused";
export const PAUSED_STRIP_LABEL = "Scanning paused. Keep scanning";
export const DISMISS = "Dismiss";
export const openLocation = (where: string) => `Open ${where}`;
export const SEARCHING = "Searching…";
export const LOCATIONS_UNAVAILABLE =
  "Can't load your Locations. Reconnect to add these cards.";
export const SAVE_FAILED = "Couldn't add these cards. Try again.";
export const CHANGE_SEARCH_TITLE = "Change card";
export const SEARCH_FIELD = "Search the catalog";

// Spec "Copy" table: the Scan Suggestion (owner-approved 2026-10-24 and 2026-10-25).
export const SUGGESTION_HEADING = "Is it one of these?";
export const NONE_OF_THESE = "None of these";

// New: the Scan Choice (lookalike-tray, 2026-10-28). Wording approved by the owner 2026-10-28 (round 2).
export const CHOICE_VERSION_HEADING = "Which version?";
export const CHOICE_FINISH_HEADING = "Which finish?";
