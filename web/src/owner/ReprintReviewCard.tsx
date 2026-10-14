import { useEffect, useRef, useState } from "react";
import { searchCatalog } from "../generated";
import {
  decideReprintGroups,
  getCardIdentityEvidence,
  mergeCardIdentities,
  requestMetadataCode,
  type CardIdentityEvidence,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { ScrollTable } from "../ui/ScrollTable";
import { SearchField } from "../ui/SearchField";
import { Select } from "../ui/Select";
import { TextArea, TextField } from "../ui/TextField";
import { CodeStep } from "./CodeStep";
import {
  codeError,
  decisionError,
  groupNames,
  hasReviewedGroups,
  legalityText,
  mergePlan,
  moveOptions,
  movePlan,
  place,
  printingLabel,
  stillQueued,
  type IdentityRow,
  type MoveChoice,
  type Plan,
} from "./reprintValues";
import { CARD_HEADING, FIELDS, ReviewCard } from "./ReviewQueue";

type Decision = "move" | "merge_groups" | "merge_identity";

type Props = {
  row: IdentityRow;
  onClose: () => void;
  /** A decision was recorded. `removed` when the identity no longer belongs in the queue; `reload` when
   * the queue must be read again (an identity merge hands its Printings to another identity's row). */
  onDone: (message: string, removed: boolean, reload: boolean) => void;
};

/**
 * The Reprint Groups review card (#171, spec "Review cards", Reprints), inline under its queue row: every
 * Printing of the Card Identity with its regulation mark, its Reprint Group and that group's legality in
 * each Format, and a Move to picker. The decision is one of: move the chosen Printings (to another group,
 * a new group, or back to their derived group), merge one group into another, or merge this Card Identity
 * into another, found by name. Each takes a review reason, a review evidence URL and a fresh code; group
 * decisions and identity merges use different codes, so changing the decision clears the code. The card
 * reads the evidence again on open and after each decision, so a decision binds to what it shows.
 */
export function ReprintReviewCard({ row, onClose, onDone }: Props) {
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [evidence, setEvidence] = useState<CardIdentityEvidence | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [decision, setDecision] = useState<Decision>("move");
  const [moves, setMoves] = useState<Record<string, MoveChoice>>({});
  const [mergeFrom, setMergeFrom] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; name: string }[] | null>(
    null
  );
  const [survivor, setSurvivor] = useState<CardIdentityEvidence | null>(null);
  const [reason, setReason] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function show(next: CardIdentityEvidence) {
    setEvidence(next);
    setDecision("move");
    setMoves({});
    setMergeFrom("");
    setMergeInto("");
    setSurvivor(null);
    setFound(null);
    setQuery("");
    setCode("");
  }

  useEffect(() => {
    let current = true;
    getCardIdentityEvidence(row.identityId).then(
      (next) => current && show(next),
      () => current && setLoadFailed(true)
    );
    return () => {
      current = false;
    };
  }, [row.identityId]);

  const names = evidence ? groupNames(evidence) : new Map<string, string>();
  let plan: Plan = { problem: "" };
  if (evidence && decision === "move") plan = movePlan(evidence, moves, names);
  else if (evidence && decision === "merge_groups")
    plan = mergePlan(mergeFrom, mergeInto, names);
  else if (evidence && decision === "merge_identity")
    plan = hasReviewedGroups(evidence)
      ? {
          problem:
            "This Card Identity has reviewed groups. Return its Printings to their derived groups first, then merge it.",
        }
      : survivor
        ? {
            body: { decision: "merge" },
            summary: `Merges ${evidence.display_name} into ${survivor.display_name}.`,
          }
        : {
            problem: "Find and choose the Card Identity this one merges into.",
          };
  const ready = !!reason.trim() && !!evidenceUrl.trim() && "body" in plan;

  function choose(next: Decision) {
    setDecision(next);
    // Group decisions and identity merges take different codes (review_reprint_groups,
    // merge_card_identities), so a code sent for one is no good for the other.
    setCode("");
    setError("");
  }

  async function find() {
    if (!evidence || !query.trim()) return;
    setError("");
    try {
      const page = await searchCatalog({ name: query.trim() });
      const identities = new Map<string, string>();
      for (const printing of page.printings)
        if (printing.identity_id !== evidence.identity_id)
          identities.set(printing.identity_id, printing.identity_name);
      setFound([...identities].map(([id, name]) => ({ id, name })));
      setSurvivor(null);
    } catch {
      setError("Unable to search the catalog. Please retry.");
    }
  }

  async function pickSurvivor(id: string) {
    setSurvivor(null);
    if (!id) return;
    try {
      setSurvivor(await getCardIdentityEvidence(id));
    } catch {
      setError("Unable to load that Card Identity. Please retry.");
    }
  }

  async function sendCode() {
    if (!evidence) return;
    setBusy(true);
    setError("");
    try {
      await requestMetadataCode(
        `card_identity:${evidence.identity_id}`,
        decision === "merge_identity"
          ? "merge_card_identities"
          : "review_reprint_groups"
      );
      setStatus("Fresh approval code sent to your email.");
    } catch (failure) {
      setStatus("");
      setError(codeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!evidence || !("body" in plan)) return;
    setBusy(true);
    setError("");
    const shared = {
      evidence_digest: evidence.evidence_digest,
      evidence_url: evidenceUrl.trim(),
      reason: reason.trim(),
      code,
    };
    try {
      if (decision === "merge_identity" && survivor) {
        await mergeCardIdentities({
          ...shared,
          identity_id: evidence.identity_id,
          into_identity_id: survivor.identity_id,
          into_evidence_digest: survivor.evidence_digest,
        });
        setCode("");
        onDone(
          `Merged ${evidence.display_name} into ${survivor.display_name}.`,
          true,
          true
        );
        return;
      }
      const result = await decideReprintGroups({
        ...shared,
        ...plan.body,
        identity_id: evidence.identity_id,
      });
      setCode("");
      const moved = result.affected_printing_ids.length;
      const message = `Reprint Groups updated for ${evidence.display_name}: ${moved === 1 ? "1 Printing" : `${moved} Printings`} moved.`;
      try {
        const next = await getCardIdentityEvidence(evidence.identity_id);
        if (!stillQueued(next)) return onDone(message, true, false);
        show(next);
        setStatus(message);
        onDone(message, false, false);
      } catch {
        // The re-read failed, so the queue must be read again rather than drop the row (#171).
        onDone(message, true, true);
      }
    } catch (failure) {
      setStatus("");
      setError(decisionError(failure));
    } finally {
      setBusy(false);
    }
  }

  const groupChoices = evidence
    ? evidence.groups.map((group) => (
        <option key={group.group_id} value={group.group_id}>
          {names.get(group.group_id)} ·{" "}
          {group.printing_ids.length === 1
            ? "1 Printing"
            : `${group.printing_ids.length} Printings`}
        </option>
      ))
    : null;

  return (
    <ReviewCard title={row.name} onClose={onClose} focusRef={reasonField}>
      <p className="m-0 text-meta text-text-muted">
        {evidence
          ? `Card Identity · ${evidence.printings.length === 1 ? "1 Printing" : `${evidence.printings.length} Printings`} · legality on ${evidence.legality_on}`
          : "Loading the Card Identity…"}
      </p>
      <p className="m-0 text-meta text-text-muted">
        Copy limits count by Card Identity. Legality and bans follow a Reprint
        Group: a Trainer or Energy is legal when any Printing in its group is. A
        Printing in no group is judged on its own.
      </p>
      {loadFailed && (
        <p role="alert" className="m-0 text-meta text-danger">
          Unable to load this Card Identity. Close it and try again.
        </p>
      )}
      {evidence && (
        <ScrollTable label="Printings and their groups">
          <thead>
            <tr>
              <th scope="col">Printing</th>
              <th scope="col">Regulation mark</th>
              <th scope="col">Reprint Group</th>
              <th scope="col">Group legality</th>
              <th scope="col">Move to</th>
            </tr>
          </thead>
          <tbody>
            {evidence.printings.map((printing) => {
              const group = evidence.groups.find(
                (entry) => entry.group_id === printing.group_id
              );
              return (
                <tr key={printing.printing_id}>
                  <td>
                    {printing.name ?? "Unnamed Printing"}
                    <span className="text-text-muted">
                      {" "}
                      · {place(printing)}
                      {printing.source === "manual" ? " · manual" : ""}
                      {printing.in_catalog ? "" : " · withdrawn"}
                    </span>
                  </td>
                  <td>{printing.regulation_mark ?? "Unknown"}</td>
                  <td>
                    {printing.group_id
                      ? names.get(printing.group_id)
                      : "No group"}
                    {printing.linked_group_id || printing.assigned_group_id
                      ? " · reviewed"
                      : ""}
                  </td>
                  <td>{group ? legalityText(group.legality) : "—"}</td>
                  <td>
                    <Select
                      label={`Move ${printingLabel(printing)} to`}
                      labelHidden
                      disabled={decision !== "move" || busy}
                      value={moves[printing.printing_id] ?? ""}
                      onChange={(event) =>
                        setMoves({
                          ...moves,
                          [printing.printing_id]: event.target
                            .value as MoveChoice,
                        })
                      }
                    >
                      {moveOptions(printing, evidence, names).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      )}
      <h4 className={CARD_HEADING}>Decide</h4>
      <TextArea
        ref={reasonField}
        label="Review reason"
        maxLength={2000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className={FIELDS}>
        <TextField
          label="Review evidence URL"
          type="url"
          value={evidenceUrl}
          onChange={(event) => setEvidenceUrl(event.target.value)}
        />
        <Select
          label="Decision"
          value={decision}
          disabled={!evidence || busy}
          onChange={(event) => choose(event.target.value as Decision)}
        >
          <option value="move">Move the chosen Printings</option>
          {evidence && evidence.groups.length > 1 && (
            <option value="merge_groups">Merge one group into another</option>
          )}
          <option value="merge_identity">
            Merge this Card Identity into another
          </option>
        </Select>
      </div>
      {decision === "merge_groups" && (
        <div className={FIELDS}>
          <Select
            label="Group to merge"
            value={mergeFrom}
            disabled={busy}
            onChange={(event) => setMergeFrom(event.target.value)}
          >
            <option value="">Choose a group</option>
            {groupChoices}
          </Select>
          <Select
            label="Into group"
            value={mergeInto}
            disabled={busy}
            onChange={(event) => setMergeInto(event.target.value)}
          >
            <option value="">Choose a group</option>
            {groupChoices}
          </Select>
        </div>
      )}
      {decision === "merge_identity" && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-meta text-text-muted">
            The Card Identity it merges into keeps its name, and this one's
            Printings move into it. Holdings, Deck Lists and Published Decks
            keep their cards.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow basis-60">
              <SearchField
                label="Find the surviving Card Identity"
                placeholder="Card name"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void find();
                }}
              />
            </div>
            <Button
              disabled={busy || !query.trim()}
              onClick={() => void find()}
            >
              Find
            </Button>
          </div>
          {found &&
            (found.length ? (
              <Select
                label="Surviving Card Identity"
                value={survivor?.identity_id ?? ""}
                disabled={busy}
                onChange={(event) => void pickSurvivor(event.target.value)}
              >
                <option value="">Choose a Card Identity</option>
                {found.map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="m-0 text-meta text-text-muted">
                No other Card Identity has a card whose name starts that way.
              </p>
            ))}
          {survivor && evidence && (
            <p className="m-0 text-meta">
              {survivor.display_name} keeps its name and gains this Card
              Identity's{" "}
              {evidence.printings.length === 1
                ? "1 Printing"
                : `${evidence.printings.length} Printings`}
              .
            </p>
          )}
        </div>
      )}
      {evidence && (
        <p className="m-0 text-meta">
          {"body" in plan ? plan.summary : plan.problem}
        </p>
      )}
      <CodeStep
        onSend={() => void sendCode()}
        code={code}
        onCode={setCode}
        confirmLabel="Confirm decision"
        ready={ready}
        busy={busy || !evidence}
        onConfirm={() => void confirm()}
      />
      <p role="status" className="m-0 text-meta">
        {status}
      </p>
      {error && (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      )}
    </ReviewCard>
  );
}
