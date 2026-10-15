import { PageHeader } from "../shell/PageHeader";
import { SignInsSection } from "../shell/SignInsSection";
import { WantListCountingSection } from "./WantListCountingSection";

/**
 * The Settings page (/settings, #207), opened from the desktop avatar menu and the phone More sheet. It replaced the
 * Sign-ins page, whose old address redirects here (routes.ts canonicalPath): a Decks section with the Want List
 * counting setting, then a Sign-ins section with the Sign-ins page's content.
 */
export function SettingsPage({ email }: { email: string | null }) {
  return (
    <main className="mx-auto box-border flex max-w-3xl flex-col gap-8 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="Settings" />
      <WantListCountingSection />
      <SignInsSection email={email} />
    </main>
  );
}
