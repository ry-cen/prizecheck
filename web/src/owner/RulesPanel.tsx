import { useEffect, useId, useState } from "react";
import { getMetadataRules, type MetadataRuleView } from "../metadata_generated";
import { when } from "../MetadataReview";
import { Pill, type PillTone } from "../ui/Pill";

const RULE_NAMES: Record<MetadataRuleView["kind"], string> = {
  live_derivation: "Live derivation",
  marketplace_matching: "Marketplace matching",
};

/** Owner controls' Rules tab: a card per rule kind (spec "Review cards", Rules). */
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
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body text-text-muted">
        Rules live in code. Activating a version records your approval for its
        exact code digest.
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

/**
 * One rule kind: its active version and every version with its code digest, the latest marked.
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

  let tone: PillTone;
  let summary: string;
  if (active && !active.digest_current) {
    tone = "bad";
    summary = "Needs approval again";
  } else if (!active) {
    tone = "warn";
    summary = "Inactive";
  } else if (latest && latest.version > (active.version ?? 0)) {
    tone = "warn";
    summary = `Version ${latest.version} ready`;
  } else {
    tone = "ok";
    summary = `Version ${active.version} active`;
  }

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
        {active
          ? `Active: version ${active.version} · activated ${when(active.activated_at)} · ${active.reason}`
          : "No active rule"}
      </p>
      {active && !active.digest_current && (
        <p role="alert" className="m-0 text-meta text-danger">
          The rule code changed after approval, so it is inactive until you
          approve it again.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta">
        {rule.versions.map((entry) => (
          <li key={entry.version}>
            Version {entry.version} · digest {entry.code_digest.slice(0, 12)}
            {entry.version === latest?.version ? " · latest" : ""}
          </li>
        ))}
      </ul>
    </article>
  );
}
