import { registerPlugin } from "@capacitor/core";
import type { CollectionPage } from "../../collection_generated";
import type { CollectionRead, CollectionSource } from "./collectionSource";

export type NativeSignInResult = "signed-in" | "cancelled" | "error";

/**
 * The native sign-in plugin. The credential lives in the iOS Keychain and never
 * reaches JavaScript: the plugin signs in, reads the Collection and signs out.
 */
export interface NativeSignInPlugin {
  status(): Promise<{ configured: boolean; signedIn: boolean }>;
  signIn(): Promise<{ result: NativeSignInResult }>;
  collection(options: {
    cursor?: string;
  }): Promise<
    | { kind: "page"; page: CollectionPage }
    | { kind: "signed-out" }
    | { kind: "unavailable" }
  >;
  signOut(): Promise<void>;
}

export const NativeSignIn = registerPlugin<NativeSignInPlugin>("NativeSignIn");

/** A web build, or any failed call, reports "not configured". */
export async function nativeStatus(
  plugin: NativeSignInPlugin
): Promise<{ configured: boolean; signedIn: boolean }> {
  try {
    const status = await plugin.status();
    return status && status.configured === true
      ? { configured: true, signedIn: status.signedIn === true }
      : { configured: false, signedIn: false };
  } catch {
    return { configured: false, signedIn: false };
  }
}

export function nativeCollectionSource(
  plugin: NativeSignInPlugin
): CollectionSource {
  return {
    sample: false,
    async read(cursor) {
      try {
        const result = await plugin.collection(
          cursor === undefined ? {} : { cursor }
        );
        if (result?.kind === "signed-out") {
          return { kind: "signed-out" } satisfies CollectionRead;
        }
        if (
          result?.kind === "page" &&
          result.page &&
          Array.isArray(result.page.entries)
        ) {
          return { kind: "page", page: result.page } satisfies CollectionRead;
        }
        return { kind: "unavailable" } satisfies CollectionRead;
      } catch {
        return { kind: "unavailable" } satisfies CollectionRead;
      }
    },
  };
}
