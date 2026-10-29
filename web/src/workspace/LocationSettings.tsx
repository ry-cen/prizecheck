import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { setLocationForTrade, setLocationHidden } from "../location_generated";
import type { TreeLocation } from "../location_generated";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { focusableIn } from "../ui/focusable";
import { Icon } from "../ui/Icon";
import { SettingRow } from "../ui/SettingRow";
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

const ALSO_HIDDEN = "It's also hidden on its own.";
const HIDE_NOTE = "Friends can't see this Location or anything in it.";
const TRADE_NOTE = "Offer the cards here, apart from Decks, in trades.";
const DELETE_NOTE = "Remove this empty Location.";
const OPEN_DECK_NOTE = "See and edit this Deck's cards.";
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
  /** The value just asked for, shown until the save settles (done, stale or refused). */
  const [pendingHide, setPendingHide] = useState<boolean | null>(null);
  const [pendingTrade, setPendingTrade] = useState<boolean | null>(null);
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

  // Once nothing is saving, show the server's value again: it is the new one after a save, the old after a refusal.
  useEffect(() => {
    if (busy) return;
    setPendingHide(null);
    setPendingTrade(null);
  }, [busy]);

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
    const hideReason =
      hiding.kind === "parent"
        ? node.hidden
          ? `${hidden}. ${ALSO_HIDDEN}`
          : hidden
        : undefined;
    // The tree read's for_trade is also true when only a parent marks the Location, so its own mark can't be told apart.
    const tradeReason = forTrade.kind === "parent" ? trading : undefined;
    // A reason from a parent is in the setting's row note; the caption keeps the Location's own marks.
    const captionHidden = hiding.kind === "parent" ? "" : hidden;
    const captionTrading = forTrade.kind === "parent" ? "" : trading;
    const deleteReason = deletable
      ? undefined
      : locationErrorMessage("LOCATION_NOT_EMPTY", { action: "delete" });
    body = (
      <>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-meta text-text-muted tabular-nums">
            {model.kindLabel(node)}
            {captionHidden && ` · ${captionHidden}`}
            {captionTrading && ` · ${captionTrading}`}
          </p>
          {stillOffered && (
            <p className={REASON}>
              {beyond ? hiddenStillOffered(path) : stillOffered}
            </p>
          )}
        </div>
        <div className="flex flex-col">
          <SettingRow
            name="Rename"
            note="Change this Location's name."
            noteId={`${reasonId}-rename`}
          >
            <Button
              aria-label={`Rename ${path}`}
              aria-describedby={`${reasonId}-rename`}
              disabled={busy}
              data-settings-focus="rename"
              onClick={() => begin("rename")}
            >
              Rename
            </Button>
          </SettingRow>
          <SettingRow
            name="Move"
            note="Put it inside another Location, or at Top level."
            noteId={`${reasonId}-move`}
          >
            <Button
              aria-label={`Move ${path}`}
              aria-describedby={`${reasonId}-move`}
              disabled={busy}
              data-settings-focus="move"
              onClick={() => begin("move")}
            >
              Move
            </Button>
          </SettingRow>
          <SettingRow
            name="Hide from Friends"
            note={hideReason ?? HIDE_NOTE}
            noteId={`${reasonId}-hide`}
          >
            <Checkbox
              aria-label={`Hide ${path} from Friends`}
              aria-describedby={`${reasonId}-hide`}
              aria-busy={pendingHide !== null || undefined}
              checked={pendingHide ?? hiding.kind !== "visible"}
              disabled={hiding.kind === "parent" || busy}
              data-settings-focus="hide"
              onChange={() => {
                restoreFocus.current = "hide";
                setNotice(null);
                setPendingHide(!node.hidden);
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
                    where:
                      hiding.kind === "parent" ? hiding.by.name : undefined,
                  }
                );
              }}
            />
          </SettingRow>
          {!deck && (
            <SettingRow
              name="For trade"
              note={tradeReason ?? TRADE_NOTE}
              noteId={`${reasonId}-trade`}
            >
              <Checkbox
                aria-label={`Mark ${path} For trade`}
                aria-describedby={`${reasonId}-trade`}
                aria-busy={pendingTrade !== null || undefined}
                checked={pendingTrade ?? forTrade.kind !== "none"}
                disabled={forTrade.kind === "parent" || busy}
                data-settings-focus="trade"
                onChange={() => {
                  restoreFocus.current = "trade";
                  setNotice(null);
                  setPendingTrade(!node.for_trade);
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
                        forTrade.kind === "parent"
                          ? forTrade.by.name
                          : undefined,
                    }
                  );
                }}
              />
            </SettingRow>
          )}
          {!deck && (
            <SettingRow
              name="Delete"
              note={deleteReason ?? DELETE_NOTE}
              noteId={`${reasonId}-delete`}
            >
              <Button
                aria-label={`Delete ${path}`}
                aria-describedby={`${reasonId}-delete`}
                disabled={!deletable || busy}
                data-settings-focus="delete"
                onClick={() => begin("delete")}
              >
                Delete
              </Button>
            </SettingRow>
          )}
          {deck && (
            <SettingRow
              name="Open in Decks"
              note={OPEN_DECK_NOTE}
              noteId={`${reasonId}-open`}
            >
              <a
                href={`/decks/${encodeURIComponent(id)}`}
                aria-label={`Open ${path} in Decks`}
                aria-describedby={`${reasonId}-open`}
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
            </SettingRow>
          )}
        </div>
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
