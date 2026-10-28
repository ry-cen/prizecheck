import { useEffect, useId, useState } from "react";
import { getMetadataRules, type MetadataRuleView } from "../metadata_generated";
import { when } from "../MetadataReview";
import { Pill, type PillTone } from "../ui/Pill";

const RULE_NAMES: Record<MetadataRuleView["kind"], string> = {
  live_derivation: "Live derivation",
  marketplace_matching: "Marketplace matching",
};

type Rollout = NonNullable<MetadataRuleView["rollout"]>;

const inProgress = (rollout: Rollout | null) =>
  rollout !== null && rollout.phase !== "done" && rollout.phase !== "failed";

/** Owner controls' Rules tab: a read-only card per rule kind (spec "Review cards", Rules; ADR 0021). */
export function RulesPanel() {
  const [rules, setRules] = useState<MetadataRuleView[]>([]);
  const [error, setError] = useState("");
  async function load() {
    try {
      setRules(await getMetadataRules());
      setError("");
    } catch {
      setError("Unable to load the metadata rules.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const applying = rules.some((rule) => inProgress(rule.rollout));
  useEffect(() => {
    if (!applying) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [applying]);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body text-text-muted">
        Rules live in code. Deploying a release applies its newest version of
        each rule; older versions stay as an archive.
      </p>
      {error && (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      )}
      {rules.map((rule) => (
        <RuleCard key={rule.kind} rule={rule} />
      ))}
    </div>
  );
}

function metaLine(active: NonNullable<MetadataRuleView["active"]>): string {
  const sha = active.release_commit?.slice(0, 7) ?? "";
  const at = when(active.activated_at);
  const v = `Version ${active.version}`;
  if (active.source === "deploy") {
    return `${v} · applied by deploying release ${sha} · ${at}`;
  }
  if (active.source === "rollback") {
    return `${v} · restored by rolling back to release ${sha} · ${at}`;
  }
  return `${v} · activated by the owner · ${at}`;
}

function rolloutLine(rollout: Rollout): string | null {
  const count = `${rollout.done.toLocaleString()} of ${(rollout.total ?? 0).toLocaleString()}`;
  switch (rollout.phase) {
    case "live":
      return "Applying: re-evaluating Printings";
    case "editions":
      return `Applying: ${count} Editions`;
    case "quote_variants":
      return `Applying: completing price variants, ${count} Editions`;
    case "deliver":
      return "Applying: publishing the changes";
    case "done":
      return `Applied ${when(rollout.finished_at ?? rollout.updated_at)} · ${rollout.changed.toLocaleString()} changed`;
    default:
      return null;
  }
}

/**
 * One rule kind: its applied version, rollout progress and every version with its code digest.
 */
function RuleCard({ rule }: { rule: MetadataRuleView }) {
  const headingId = useId();
  const latest = rule.versions.reduce<
    MetadataRuleView["versions"][number] | null
  >(
    (best, entry) => (!best || entry.version > best.version ? entry : best),
    null
  );
  const active =
    rule.active && rule.active.version !== null ? rule.active : null;
  const rollout = rule.rollout;

  let tone: PillTone;
  let summary: string;
  if (rule.problem === "digest_mismatch") {
    tone = "bad";
    summary = "Code differs";
  } else if (rule.problem === "newer_than_code") {
    tone = "bad";
    summary = "Newer than this release";
  } else if (!active) {
    tone = "warn";
    summary = "No rule applied";
  } else if (rollout?.phase === "failed") {
    tone = "bad";
    summary = "Rollout failed";
  } else if (inProgress(rollout)) {
    tone = "warn";
    summary = "Applying";
  } else {
    tone = "ok";
    summary = `Version ${active.version} applied`;
  }

  const progress = rollout ? rolloutLine(rollout) : null;

  return (
    <article
      aria-labelledby={headingId}
      className="box-border flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="m-0 mr-auto text-body font-semibold">
          {RULE_NAMES[rule.kind]}
        </h2>
        <Pill tone={tone}>{summary}</Pill>
      </div>
      <p className="m-0 text-meta text-text-muted">
        {active ? metaLine(active) : "No rule applied yet"}
      </p>
      {progress && (
        <p role="status" className="m-0 text-meta">
          {progress}
        </p>
      )}
      {rollout?.phase === "failed" && (
        <p role="alert" className="m-0 text-meta text-danger">
          Rollout failed: {rollout.error ?? "unknown error"}. It retries
          automatically.
        </p>
      )}
      {rule.problem === "digest_mismatch" && (
        <p role="alert" className="m-0 text-meta text-danger">
          Rule code differs from the applied version. It is not applied; a
          changed rule ships as a new version.
        </p>
      )}
      {rule.problem === "newer_than_code" && (
        <p role="alert" className="m-0 text-meta text-danger">
          The applied version is newer than this release knows.
        </p>
      )}
      <h3 className="m-0 text-meta font-semibold">Versions</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta">
        {rule.versions.map((entry) => (
          <li key={entry.version}>
            Version {entry.version} · digest {entry.code_digest.slice(0, 12)}
            {entry.version === active?.version ? " · applied" : ""}
            {entry.version === latest?.version ? " · newest" : ""}
          </li>
        ))}
      </ul>
    </article>
  );
}
