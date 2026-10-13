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
import { OwnerMissingCardReview } from "../MissingCardReports";
import { PageHeader } from "../shell/PageHeader";
import { Pill } from "../ui/Pill";
import { Segmented, segmentId } from "../ui/Segmented";
import { AttributesQueue } from "./AttributesQueue";
import { healthChecks, problems } from "./health";
import { RulesPanel } from "./RulesPanel";
import { OWNER_SECTIONS, type OwnerSection } from "./sections";
import { PANEL, StatusPanel } from "./StatusPanel";
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
 * then sub-tabs with counts. Status, Rules and Attributes (#170) are on the kit. The other queue tabs
 * show today's review components on an old light panel until #168 (Catalog, Metadata, Missing cards)
 * and #171 (Reprints) move them onto ScrollTables. While a catalog run is in progress the pull status is read
 * again every 5 seconds.
 */
export function OwnerControlsPage(props: Props) {
  return (
    <main className="mx-auto box-border flex max-w-6xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
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
      content = (
        <LegacyQueue>
          <CatalogReview />
        </LegacyQueue>
      );
      break;
    case "metadata":
      content = (
        <LegacyQueue>
          <MetadataReview />
        </LegacyQueue>
      );
      break;
    case "attributes":
      content = <AttributesQueue onDecided={refreshCounts} />;
      break;
    case "reprints":
      content = (
        <ComingQueue
          title="Reprint Groups"
          count={tabCounts.reprints}
          what="Reprint Groups"
        />
      );
      break;
    case "missing":
      content = (
        <LegacyQueue>
          <OwnerMissingCardReview />
        </LegacyQueue>
      );
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

/** Today's review component for a queue, unchanged on the old light look, until its ticket moves it onto
 * the kit. */
function LegacyQueue({ children }: { children: ReactNode }) {
  return <div className="legacy legacy-inset">{children}</div>;
}

/** A queue whose page arrives with its own ticket (#171); its count is already on its tab. */
function ComingQueue({
  title,
  count,
  what,
}: {
  title: string;
  count: string | undefined;
  what: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={PANEL}>
      <h2 id={headingId} className="m-0 text-body font-semibold">
        {title}
      </h2>
      <p className="m-0 text-body text-text-muted">
        {count === undefined ? "" : `Waiting for review: ${count}. `}
        Reviewing {what} on this page comes in a later update.
      </p>
    </section>
  );
}
