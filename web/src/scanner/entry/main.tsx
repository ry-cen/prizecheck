import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoadingScreen } from "../../public/LoadingScreen";
import { leaveForSignIn, startScanner, type ScannerStart } from "./bootstrap";
import { ScannerPageStub } from "./ScannerPageStub";
import "../../tokens.css";
import "../../tailwind.css";

/** The scanner's own entry (web/scan.html, served at /collection/scan with COOP and COEP). It mounts the scanner and
 * nothing else of the app. */
function ScannerEntry() {
  const [start, setStart] = useState<ScannerStart | null>(null);
  useEffect(() => {
    let current = true;
    void startScanner().then((result) => {
      if (!current) return;
      if (result.kind === "signed-out") leaveForSignIn();
      else setStart(result);
    });
    return () => {
      current = false;
    };
  }, []);
  if (start?.kind === "ready") return <ScannerPageStub userId={start.userId} />;
  return (
    <LoadingScreen
      message={
        start?.kind === "unavailable"
          ? "Service temporarily unavailable. Please retry."
          : ""
      }
    />
  );
}

createRoot(document.getElementById("root")!).render(<ScannerEntry />);
