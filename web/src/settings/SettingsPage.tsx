import { PageHeader } from "../shell/PageHeader";
import { SignInsSection } from "../shell/SignInsSection";
import { PrivacySection } from "./PrivacySection";
import { WantListCountingSection } from "./WantListCountingSection";

/**
 * The Settings page (/settings, #207), opened from the desktop avatar menu and the phone account sheet. It replaced
 * the Sign-ins page, whose old address redirects here (routes.ts canonicalPath): a Decks section with the Want List
 * counting setting, a Privacy section with the collector's names and Invite Link (#246), then a Sign-ins section with
 * the Sign-ins page's content (the account sheet's Sign-ins opens it at #sign-ins).
 */
export function SettingsPage({ email }: { email: string | null }) {
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-8 px-7 py-7 phone:px-4 phone:py-5 [&>*]:max-w-3xl">
      <PageHeader title="Settings" />
      <WantListCountingSection />
      <PrivacySection />
      <SignInsSection email={email} />
    </main>
  );
}
