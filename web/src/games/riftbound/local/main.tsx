import { createRoot } from "react-dom/client";
import "../../../tokens.css";
import "../../../tailwind.css";
import { RiftboundApp } from "../RiftboundApp";
import { fixtureReader, type Scenario } from "./fixtures";
import {
  collectionFixtureReader,
  collectionFixtureWriter,
  type CollectionScenario,
} from "./collectionFixtures";
const params = new URLSearchParams(location.search);
const scenario = new URLSearchParams(location.search).get(
  "scenario"
) as Scenario | null;
// This HTML is a dev-server entry only, absent from the production Rollup inputs.
createRoot(document.getElementById("root")!).render(
  <RiftboundApp
    reader={fixtureReader(scenario ?? "normal")}
    writer={collectionFixtureWriter(
      params.get("owner") === "b" ? "b" : "a",
      (params.get("collection") ?? "normal") as CollectionScenario
    )}
    collection={collectionFixtureReader(
      params.get("owner") === "b" ? "b" : "a",
      (params.get("collection") ?? "normal") as CollectionScenario
    )}
  />
);
