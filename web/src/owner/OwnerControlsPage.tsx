import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getOperationsStatus,
  getOwnerCatalogStatus,
  startCatalogRun,
  type OperationsStatus,
  type OwnerCatalogStatus,
} from "../generated";
import { CatalogReview } from "../CatalogReview";
import { MetadataReview } from "../MetadataReview";
import { MissingQueue } from "./MissingQueue";
import { PageHeader } from "../shell/PageHeader";
import { Pill } from "../ui/Pill";
import { Segmented, segmentId } from "../ui/Segmented";
import { AttributesQueue } from "./AttributesQueue";
import { healthChecks, problems } from "./health";
import { ReprintsQueue } from "./ReprintsQueue";
import { RulesPanel } from "./RulesPanel";
import { OWNER_SECTIONS, type OwnerSection } from "./sections";
import { StatusPanel } from "./StatusPanel";
import { useQueueCounts } from "./useQueueCounts";

type Props = {
  /** The owner's catalog status; null for anyone else, who sees the heading and nothing more. */
  status: OwnerCatalogStatus | null;
  section: OwnerSection;
  onSection: (section: OwnerSection) => void;
  /** A catalog status read; null when the owner binding is gone (403), which closes the page. */
  onStatus: (status: OwnerCatalogStatus | null) => void;
  /** The app's last service message. */
  message: string;
  onMessage: (message: string) => void;
};

/**
 * Owner controls (#167, variant A of the Missing cards and Owner controls decision): the problems line,
 * then sub-tabs with counts. Status and Rules are on the kit. Catalog, Metadata and Missing cards are
 * review queues on ScrollTables, with the review card inline under its row (#168), and so is Reprints
 * (#171); Attributes (#170) is on the kit too, with its own queue table. While a catalog run is in
 * progress the pull status is read again every 5 seconds.
 */
export function OwnerControlsPage(props: Props) {
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="Owner controls" />
      <p role="alert" className="m-0 text-body text-danger">
        {props.message}
      </p>
      {props.status && <OwnerControls {...props} status={props.status} />}
    </main>
  );
}

function OwnerControls({
  status,
  section,
  onSection,
  onStatus,
  onMessage,
}: Props & { status: OwnerCatalogStatus }) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const [operations, setOperations] = useState<OperationsStatus | null>(null);
  const [operationsFailed, setOperationsFailed] = useState(false);
  const { counts, refresh: refreshCounts } = useQueueCounts(section);

  // Only the latest read may set the state, so a slow earlier read can't overwrite a newer one.
  const latestRead = useRef(0);
  const readOperations = useCallback(async () => {
    const mine = ++latestRead.current;
    try {
      const next = await getOperationsStatus();
      if (mine !== latestRead.current) return;
      setOperations(next);
      setOperationsFailed(false);
    } catch {
      if (mine === latestRead.current) setOperationsFailed(true);
    }
  }, []);
  // Read with the counts on opening and on every tab switch, with the catalog status too, so a run
  // started after sign-in shows on the next view.
  useEffect(() => {
    void readOperations();
    void getOwnerCatalogStatus()
      .then(onStatus)
      .catch(() => onMessage("Catalog status temporarily unavailable."));
  }, [section, readOperations]);

  useEffect(() => {
    if (!status.run || status.run.outcome) return;
    const timer = window.setInterval(() => {
      void getOwnerCatalogStatus()
        .then(onStatus)
        .catch(() => onMessage("Catalog status temporarily unavailable."));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status.run?.outcome]);

  function refresh() {
    onMessage("");
    void getOwnerCatalogStatus()
      .then(onStatus)
      .catch(() => onMessage("Catalog status temporarily unavailable."));
    void readOperations();
    refreshCounts();
  }
  // A confirmed decision changes its queue's count: Catalog's comes from the operational status, the
  // others from useQueueCounts.
  function recount() {
    void readOperations();
    refreshCounts();
  }
  async function start() {
    onMessage("");
    try {
      onStatus(await startCatalogRun());
    } catch {
      onMessage("Unable to start catalog pull. Please retry.");
    }
  }

  const tabCounts: Partial<Record<OwnerSection, string>> = {
    ...counts,
    catalog: operations
      ? String(operations.catalog_pending_reviews)
      : undefined,
  };
  const found = operations ? problems(healthChecks(operations)) : [];

  let content: ReactNode;
  switch (section) {
    case "status":
      content = (
        <StatusPanel
          status={status}
          operations={operations}
          operationsFailed={operationsFailed}
          onRefresh={refresh}
          onStart={() => void start()}
        />
      );
      break;
    case "catalog":
      content = <CatalogReview onChanged={recount} />;
      break;
    case "metadata":
      content = <MetadataReview onChanged={recount} />;
      break;
    case "attributes":
      content = <AttributesQueue onDecided={refreshCounts} />;
      break;
    case "reprints":
      content = <ReprintsQueue onChanged={recount} />;
      break;
    case "missing":
      content = <MissingQueue onChanged={recount} />;
      break;
    case "rules":
      content = <RulesPanel />;
      break;
  }

  return (
    <>
      {operations ? (
        found.length ? (
          <ul
            aria-label="Problems"
            className="m-0 flex list-none flex-wrap gap-2 p-0"
          >
            {found.map((check) => (
              <li key={`${check.area}:${check.check}`} className="max-w-full">
                <Pill tone={check.tone}>
                  {check.check}: {check.value}
                </Pill>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-meta text-text-muted">
            All health checks are OK.
          </p>
        )
      ) : operationsFailed ? (
        <p role="alert" className="m-0 text-meta text-danger">
          Operational health temporarily unavailable.
        </p>
      ) : null}
      <Segmented
        label="Owner controls sections"
        idBase={idBase}
        panelId={panelId}
        value={section}
        onChange={onSection}
        options={OWNER_SECTIONS.map((entry) => ({
          value: entry.id,
          label: entry.label,
          count: entry.queue ? tabCounts[entry.id] : undefined,
        }))}
      />
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={segmentId(idBase, section)}
        className="flex min-w-0 flex-col gap-4"
      >
        {content}
      </div>
    </>
  );
}
