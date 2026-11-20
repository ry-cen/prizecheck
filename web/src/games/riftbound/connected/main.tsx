import { createRoot } from "react-dom/client";
import "../../../tokens.css";
import "../../../tailwind.css";
import { RiftboundApp } from "../RiftboundApp";
import { connectedReader } from "./reader";
// This HTML is a dev-server entry only, absent from the production Rollup inputs. It reads the real Catalog API and has no fixture fallback.
createRoot(document.getElementById("root")!).render(
  <RiftboundApp reader={connectedReader()} />
);
