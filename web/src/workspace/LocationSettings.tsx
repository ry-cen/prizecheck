import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { setLocationForTrade, setLocationHidden } from "../location_generated";
import type { TreeLocation } from "../location_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { focusableIn } from "../ui/focusable";
import { Icon } from "../ui/Icon";
import { useVisibleBeyondFriends } from "../settings/useVisibleBeyondFriends";
import { hiddenStillOffered } from "../trades/nearYouMessages";
import {
  DeleteStep,
  MoveStep,
  RenameStep,
  useLocationRun,
  type LocationAction,
} from "./locationSteps";
import { forTradeLabel, hidingLabel, stillOfferedLine } from "./locationTree";
import {
  buildManageModel,
  isDeck,
  locationErrorMessage,
  type ParentTarget,
} from "./manageLocationsModel";

type Props = {
  nodes: TreeLocation[];
  id: string;
  /** The title if the Location leaves the tree. */
  openedPath: string;
  returnFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Reloads the gallery and resolves once the tree is read again. */
  onChanged: () => Promise<void>;
  onDeleted: (deleted: {
    id: string;
    parentId: string | null;
    path: string;
  }) => void;
  onOpenDeck: (deckId: string) => void;
};

type Step =
  | { kind: "list" }
  | { kind: "rename" }
  | { kind: "move"; target?: ParentTarget }
  | { kind: "delete" };

const ITEM = "flex flex-col items-start gap-1 phone:items-stretch";
const REASON = "m-0 text-meta text-text-muted";

/** One Location's own settings (#292): Rename, Move, Hide from Friends, For trade and Delete, or for a Deck
 * Rename, Move, Hide from Friends and Open in Decks. Rename, Move and Delete run as steps inside it. It reads
 * the Workspace's tree on every render, so each change sends the Location's current version. */
export function LocationSettings({
  nodes,
  id,
  openedPath,
  returnFocus,
  onClose,
  onChanged,
  onDeleted,
  onOpenDeck,
}: Props) {
  const beyond = useVisibleBeyondFriends();
  const model = useMemo(() => buildManageModel(nodes), [nodes]);
  const node = model.get(id);
  const [lastPath, setLastPath] = useState(openedPath);
  const path = node ? model.index.path(id) : lastPath;
  useEffect(() => {
    if (node && path !== lastPath) setLastPath(path);
  }, [node, path, lastPath]);
  const [step, setStep] = useState<Step>({ kind: "list" });
  /** data-settings-focus key of the control to focus when the list shows again. */
  const restoreFocus = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();

  const { busy, error, setError, notice, setNotice, run } = useLocationRun({
    reload: onChanged,
    settled: (outcome: "done" | "stale", action: LocationAction) => {
      if (outcome === "done" && action === "delete" && node)
        onDeleted({ id: node.id, parentId: node.parent_id, path });
      else setStep({ kind: "list" });
    },
  });

  // When the list shows again, focus the control that started the step (or Close). Chromium drops focus
  // from a focused button that becomes disabled, so it is put back once the change is done.
  useEffect(() => {
    if (step.kind !== "list" || busy) return;
    const key = restoreFocus.current;
    if (!key) return;
    restoreFocus.current = null;
    const root = rootRef.current;
    const dialog = root?.closest("dialog");
    const target =
      root?.querySelector<HTMLElement>(
        `[data-settings-focus="${CSS.escape(key)}"]:not(:disabled)`
      ) ?? (dialog ? focusableIn(dialog)[0] : undefined);
    target?.focus();
  }, [step, node, busy]);

  function begin(kind: "rename" | "move" | "delete") {
    restoreFocus.current = kind;
    setNotice(null);
    setError("");
    setStep({ kind } as Step);
  }
  function backToList() {
    setError("");
    setStep({ kind: "list" });
  }

  let body: React.ReactNode;
  if (!node) {
    body = (
      <>
        <p className="m-0">{lastPath} no longer exists.</p>
        <div>
          <Button onClick={onClose}>Close</Button>
        </div>
      </>
    );
  } else if (step.kind !== "list") {
    const shared = {
      node,
      model,
      busy,
      run,
      setError,
      onCancel: backToList,
    };
    body =
      step.kind === "rename" ? (
        <RenameStep {...shared} />
      ) : step.kind === "move" ? (
        <MoveStep
          {...shared}
          target={step.target}
          onTarget={(target) => setStep({ kind: "move", target })}
        />
      ) : (
        <DeleteStep {...shared} />
      );
  } else {
    const hiding = model.index.hiding(id);
    const forTrade = model.index.forTrade(id);
    const hidden = hidingLabel(hiding);
    const trading = forTradeLabel(forTrade);
    const stillOffered = stillOfferedLine(hiding, forTrade);
    const deck = isDeck(node);
    const deletable = model.deletable(node);
    const hideReason = hiding.kind === "parent" ? hidden : undefined;
    const tradeReason = forTrade.kind === "parent" ? trading : undefined;
    const deleteReason = deletable
      ? undefined
      : locationErrorMessage("LOCATION_NOT_EMPTY", { action: "delete" });
    body = (
      <>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-meta text-text-muted tabular-nums">
            {model.kindLabel(node)}
            {hidden && ` · ${hidden}`}
            {trading && ` · ${trading}`}
          </p>
          {stillOffered && (
            <p className={REASON}>
              {beyond ? hiddenStillOffered(path) : stillOffered}
            </p>
          )}
        </div>
        <div className={ITEM}>
          <Button
            aria-label={`Rename ${path}`}
            disabled={busy}
            data-settings-focus="rename"
            onClick={() => begin("rename")}
          >
            Rename
          </Button>
        </div>
        <div className={ITEM}>
          <Button
            aria-label={`Move ${path}`}
            disabled={busy}
            data-settings-focus="move"
            onClick={() => begin("move")}
          >
            Move
          </Button>
        </div>
        <div className={ITEM}>
          <Button
            aria-label={
              node.hidden
                ? `Show ${path} to Friends`
                : `Hide ${path} from Friends`
            }
            title={hideReason}
            aria-describedby={hideReason ? `${reasonId}-hide` : undefined}
            disabled={hiding.kind === "parent" || busy}
            data-settings-focus="hide"
            onClick={() => {
              restoreFocus.current = "hide";
              setNotice(null);
              void run(
                "hide",
                () =>
                  setLocationHidden(node.id, {
                    hidden: !node.hidden,
                    version: node.version,
                    idempotency_key: crypto.randomUUID(),
                  }),
                node.hidden
                  ? `${path} is shown to Friends again.`
                  : `${path} and everything in it are hidden from Friends.`,
                {
                  where: hiding.kind === "parent" ? hiding.by.name : undefined,
                }
              );
            }}
          >
            {node.hidden ? "Show to Friends" : "Hide from Friends"}
          </Button>
          {hideReason && (
            <p id={`${reasonId}-hide`} className={REASON}>
              {hideReason}
            </p>
          )}
        </div>
        {!deck && (
          <div className={ITEM}>
            <Button
              aria-label={
                node.for_trade
                  ? `Mark ${path} Not for trade`
                  : `Mark ${path} For trade`
              }
              title={tradeReason}
              aria-describedby={tradeReason ? `${reasonId}-trade` : undefined}
              disabled={forTrade.kind === "parent" || busy}
              data-settings-focus="trade"
              onClick={() => {
                restoreFocus.current = "trade";
                setNotice(null);
                void run(
                  "for_trade",
                  () =>
                    setLocationForTrade(node.id, {
                      for_trade: !node.for_trade,
                      version: node.version,
                      idempotency_key: crypto.randomUUID(),
                    }),
                  node.for_trade
                    ? `${path} is no longer For trade.`
                    : `${path} and everything in it, apart from Decks, are For trade.`,
                  {
                    name: path,
                    where:
                      forTrade.kind === "parent" ? forTrade.by.name : undefined,
                  }
                );
              }}
            >
              {node.for_trade ? "Not for trade" : "For trade"}
            </Button>
            {tradeReason && (
              <p id={`${reasonId}-trade`} className={REASON}>
                {tradeReason}
              </p>
            )}
          </div>
        )}
        {!deck && (
          <div className={ITEM}>
            <Button
              aria-label={`Delete ${path}`}
              title={deleteReason}
              aria-describedby={deleteReason ? `${reasonId}-delete` : undefined}
              disabled={!deletable || busy}
              data-settings-focus="delete"
              onClick={() => begin("delete")}
            >
              Delete
            </Button>
            {deleteReason && (
              <p id={`${reasonId}-delete`} className={REASON}>
                {deleteReason}
              </p>
            )}
          </div>
        )}
        {deck && (
          <div className={ITEM}>
            <a
              href={`/decks/${encodeURIComponent(id)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onOpenDeck(id);
              }}
              className="inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone"
            >
              Open in Decks
              <Icon icon={ArrowRight} />
            </a>
          </div>
        )}
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={path}
      closeLabel="Close settings"
      returnFocus={returnFocus}
    >
      <div ref={rootRef} className="flex flex-col gap-3">
        <p
          className={`m-0 text-meta empty:-mb-3 ${notice?.tone === "alert" ? "text-danger" : "text-text"}`}
          role={notice?.tone ?? "status"}
        >
          {notice?.text ?? ""}
        </p>
        {body}
        {error && (
          <p className="m-0 text-meta text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
