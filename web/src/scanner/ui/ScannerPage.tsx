import { ScannerScreen } from "./ScannerScreen";
import { useTrayStore } from "./useTray";

/** The scanner page: full screen, no app header or tab bar. Mounted only by the scanner entry. */
export function ScannerPage({ userId }: { userId: string }) {
  const store = useTrayStore(userId);
  return (
    <main
      data-testid="scanner-page"
      data-user-id={userId}
      className="fixed inset-0"
    >
      {store ? (
        <ScannerScreen store={store} />
      ) : (
        <div className="absolute inset-0 bg-bg" />
      )}
    </main>
  );
}
