import { PageHeader } from "./PageHeader";

/** Sign-ins, opened from the avatar menu and the More sheet. Until OAuth sign-in lands (#156 builds the
 * provider list here), it names the account's email and today's way in. */
export function SignInsPage({ email }: { email: string | null }) {
  return (
    <main className="mx-auto box-border max-w-3xl px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="Sign-ins" />
      <p className="m-0 mb-2 text-body">
        Your account email: {email ?? "not available right now"}
      </p>
      <p className="m-0 text-body text-text-muted">
        You sign in with a six-digit code sent to this email.
      </p>
    </main>
  );
}
