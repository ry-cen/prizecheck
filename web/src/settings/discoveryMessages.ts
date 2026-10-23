import { SocialError } from "../social_generated";

// Open discovery's collector-facing copy (Trading #297, Stage 2 spec "Approved copy"). Every string is the owner's
// approved wording, kept here so a change touches this file and the spec alone.

export const DISCOVERY_HEADING = "Open discovery";
export const DISCOVERY_HELP =
  "Let collectors near you who also use open discovery find you, see your Trade List and message you. Nobody else sees your zip code.";
export const ZIP_LABEL = "Zip code";
export const ZIP_SAVE = "Save zip code";
export const DISCOVERY_ON = "Open discovery is on.";
export const DISCOVERY_OFF = "Open discovery is off.";
export const ZIP_SAVED = "Zip code saved.";
export const DISCOVERY_REMOVED =
  "Open discovery isn't available for your account.";
export const ACCOUNT_SUSPENDED_NOTE =
  "Your account can't trade or message right now.";
export const DISCOVERY_CREDIT =
  "Zip code locations include data from GeoNames (geonames.org), CC BY 4.0.";
export const DISCOVERY_LOAD_FAILED = "Open discovery couldn't be loaded.";
export const DISCOVERY_SAVE_FAILED =
  "The setting couldn't be saved. Check your connection and try again.";

const UNKNOWN_ZIP =
  "We couldn't find that zip code. Try the zip code where you'd meet.";
const INVALID_ZIP = "Enter a 5-digit zip code.";
const ZIP_REQUIRED = "Enter your zip code to turn on open discovery.";

/** "Zip code changes left: N". */
export function changesLeft(n: number): string {
  return `Zip code changes left: ${n}`;
}

/** What a refused or failed Open discovery save says. */
export function discoveryMessage(cause: unknown): string {
  const code = cause instanceof SocialError ? cause.code : "";
  switch (code) {
    case "ZIP_CHANGE_LIMIT": {
      const detail = cause instanceof SocialError ? cause.detail : {};
      const minutes = Number(detail.retry_after_minutes);
      const first =
        "You've changed your zip code 3 times in the last 24 hours.";
      if (!(minutes > 0)) return `${first} Try again later.`;
      const hours = Math.ceil(minutes / 60);
      return `${first} Try again in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
    }
    case "UNKNOWN_ZIP":
      return UNKNOWN_ZIP;
    case "INVALID_ZIP":
      return INVALID_ZIP;
    case "ZIP_REQUIRED":
      return ZIP_REQUIRED;
    default:
      return DISCOVERY_SAVE_FAILED;
  }
}
