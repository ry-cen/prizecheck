/** Stands in for ScannerPage until the scanner page slice (#318) mounts the real one here. */
export function ScannerPageStub({ userId }: { userId: string }) {
  return (
    <main
      data-testid="scanner-page"
      data-user-id={userId}
      className="flex min-h-dvh items-center justify-center bg-bg font-sans text-text scheme-dark"
    >
      <p className="m-0 text-heading font-bold text-text-muted">Scanner</p>
    </main>
  );
}
