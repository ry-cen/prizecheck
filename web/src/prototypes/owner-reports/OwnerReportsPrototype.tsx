// PROTOTYPE — throwaway. Three answers to "how do Missing cards and Owner controls look and behave on the shared
// components, on desktop and phones?" for "Prototype Missing cards and Owner controls" (#139), switched with ?ops=A|B|C.
//   A  Sections + tables: Owner controls is a status block plus one sub-tab per queue. Each queue is a ScrollTable and
//      a row's review card opens inline under it, with its six-digit code step on the card. Missing cards keeps
//      today's split: My reports (a table) and Report a card (a form).
//   B  Inbox: the queues sit in the shell's sidebar (☰ on a phone) and each one is a list with a detail pane. A decision
//      is confirmed in one dialog that sends the code and takes it. Missing cards becomes the one "My reports" hub for
//      every kind of report (missing card, metadata, attribute), each a conversation with the owner.
//   C  Dashboard + focused review: Owner controls opens on status tiles and queue tiles. A queue tile starts a
//      one-at-a-time review ("2 of 7") with a sticky decision bar holding the code. Missing cards is a guided
//      three-step report (with a Printing search instead of a raw Printing ID) above report cards.
// Sample data only. Every decision is a stub that shows a toast. The attribute and Reprint Group queues have APIs on
// dev but no UI today; they are drawn here so the owner can say whether they belong in this redesign.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Shell } from "../app-shell/AppShellPrototype";
import {
  ATTRIBUTE_ROWS,
  EDITIONS_OF_IONO,
  HEALTH,
  HISTORY,
  ITEMS,
  LAST_SUCCESS,
  METADATA_COMPARE,
  METADATA_REPORTS,
  MORE_METADATA,
  MY_REPORTS,
  PRINTING_SUGGESTIONS,
  PULL_STATES,
  QUEUES,
  REPLACEMENTS,
  REPRINT_GROUPS,
  RULES,
  type Health,
  type Item,
  type MyReport,
  type QueueId,
} from "./sample";
import "./OwnerReportsPrototype.css";

export const OPS_VARIANTS = [
  { key: "A", name: "Sections + tables" },
  { key: "B", name: "Inbox" },
  { key: "C", name: "Dashboard + focused review" },
] as const;
export type OpsVariant = (typeof OPS_VARIANTS)[number]["key"];
type Pull = keyof typeof PULL_STATES;
type Tab = "status" | QueueId | "rules";

// ---------- store ----------
type OpsState = {
  variant: OpsVariant;
  pull: Pull;
  tab: Tab;
  open: string | null;
  more: boolean;
  done: Set<string>;
  confirm: { item: Item; decision: string } | null;
  drill: QueueId | "rules" | null;
  idx: number;
  myTab: "mine" | "new";
  myOpen: string | null;
  myFilter: "all" | "needs" | "open" | "closed";
  newReport: boolean;
  toast: string | null;
};
const initial = new URLSearchParams(location.search).get("ops");
let state: OpsState = {
  variant: (["A", "B", "C"].includes(initial ?? "") ? initial : "A") as OpsVariant,
  pull: "running",
  tab: "status",
  open: null,
  more: false,
  done: new Set(),
  confirm: null,
  drill: null,
  idx: 0,
  myTab: "mine",
  myOpen: null,
  myFilter: "all",
  newReport: false,
  toast: null,
};
const subs = new Set<() => void>();
function set(p: Partial<OpsState> | ((s: OpsState) => Partial<OpsState>)) {
  state = { ...state, ...(typeof p === "function" ? p(state) : p) };
  subs.forEach((f) => f());
}
export function useOps() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state
  );
}
export function setOpsVariant(v: OpsVariant) {
  const url = new URL(location.href);
  url.searchParams.set("ops", v);
  history.replaceState(null, "", url);
  set({ variant: v, open: null, confirm: null, drill: null, idx: 0, myOpen: null, newReport: false });
}
function toast(text: string) {
  set({ toast: text });
  window.setTimeout(() => set((s) => (s.toast === text ? { toast: null } : {})), 4500);
}
function decide(item: Item, what: string) {
  set((s) => ({ done: new Set([...s.done, item.id]), open: null, confirm: null }));
  toast(`${what}: ${item.title} ${item.sub}`);
}
function items(s: OpsState, q: QueueId) {
  return [...ITEMS, ...(s.more ? MORE_METADATA : [])].filter((i) => i.queue === q && !s.done.has(i.id));
}
const count = (s: OpsState, q: QueueId) => items(s, q).length;

// ---------- shared pieces ----------
function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`ox-pill ox-${tone.replace(/\s/g, "-")}`}>{children}</span>;
}
function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ox-scroll" tabIndex={0} role="region" aria-label={`${label}, scrolls sideways`}>
      <table className="ox-table">{children}</table>
    </div>
  );
}
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`ox-field${wide ? " ox-field-wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input className="ox-input" {...p} />;
const Area = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="ox-input ox-area" {...p} />;
function Select({ options, value }: { options: string[]; value?: string }) {
  const [v, setV] = useState(value ?? options[0]);
  return (
    <select className="ox-input" value={v} onChange={(e) => setV(e.target.value)}>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}
function Btn({ children, primary, danger, onClick, disabled }: { children: ReactNode; primary?: boolean; danger?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`dx-b${primary ? " dx-b-primary" : ""}${danger ? " ox-danger" : ""}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** The fresh six-digit code step, inline (A) or inside the confirm dialog (B) or decision bar (C). */
function CodeStep({ onConfirm, label, autoSent }: { onConfirm: () => void; label: string; autoSent?: boolean }) {
  const [sent, setSent] = useState(!!autoSent);
  const [code, setCode] = useState("");
  return (
    <div className="ox-code">
      {sent ? (
        <span className="ox-muted ox-small">Code sent to owner@prizecheck.app · <button type="button" className="ox-link" onClick={() => toast("Fresh code sent")}>Resend</button></span>
      ) : (
        <Btn onClick={() => setSent(true)}>Send code</Btn>
      )}
      <input
        className="ox-input ox-codein"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="6-digit code"
        aria-label="Fresh six-digit code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
      />
      <Btn primary disabled={!sent || code.length !== 6} onClick={onConfirm}>
        {label}
      </Btn>
    </div>
  );
}

const DECISIONS: Record<QueueId, string[]> = {
  catalog: ["Deprecate Printing and map every Edition", "Keep existing physical identity", "Confirm same physical Printing", "Deprecate an Edition and link replacement"],
  metadata: ["Correct mapping", "Accept source mapping", "Reject source value", "Leave unmapped"],
  attributes: ["Correct attributes", "Remove correction"],
  reprints: ["Move Printings between groups", "Merge Card Identity into another"],
  missing: ["Approve shared record", "Request information", "Reject"],
};

/** What the owner reads and edits for one item. Shared by every variant; only the layout around it differs. */
function ReviewBody({ item }: { item: Item }) {
  const q = item.queue;
  return (
    <div className="ox-body">
      {q === "catalog" && (
        <>
          <p className="ox-small">
            TCGdex now reports <strong>{item.title} {item.sub}</strong> under a new source ID with a different Edition list. Incoming name: {item.title}.
          </p>
          <div className="ox-grid2">
            <Field label="Replacement Printing">
              <Select options={["Iono · Paldea Evolved #185 (sv02-185)", "Iono · Paldea Evolved #254"]} />
            </Field>
          </div>
          <p className="ox-muted ox-small">Holdings stay on their Edition until their collector reassigns them.</p>
          <ScrollTable label="Edition mapping">
            <thead>
              <tr>
                <th>Deprecated Edition</th>
                <th>Holdings</th>
                <th>Replacement Edition</th>
                <th>Source ID</th>
              </tr>
            </thead>
            <tbody>
              {EDITIONS_OF_IONO.map((e, i) => (
                <tr key={e.id}>
                  <td>{e.label}</td>
                  <td className="dx-num">{e.holdings}</td>
                  <td>
                    <Select options={["Choose physical Edition", ...REPLACEMENTS]} value={REPLACEMENTS[i] ?? "Choose physical Edition"} />
                  </td>
                  <td className="ox-muted">sv02-185-{e.id}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </>
      )}
      {q === "metadata" && (
        <>
          <p className="ox-small">
            State: {item.flag?.toLowerCase() ?? "pending"} · target {item.kind} · revision 14
          </p>
          <ScrollTable label="Source and reviewed values">
            <thead>
              <tr>
                <th>Field</th>
                <th>Source value</th>
                <th>Reviewed value</th>
              </tr>
            </thead>
            <tbody>
              {METADATA_COMPARE.map((r) => (
                <tr key={r.field} className={r.source !== r.reviewed ? "ox-diff" : undefined}>
                  <td>{r.field}</td>
                  <td>{r.source}</td>
                  <td>{r.reviewed}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          {item.reports > 0 && (
            <>
              <h4 className="ox-h">Linked reports ({item.reports})</h4>
              <ul className="ox-reports">
                {METADATA_REPORTS.slice(0, item.reports).map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>Report {r.id}</strong> <Pill tone={r.status}>{r.status}</Pill> <span className="ox-muted">{r.issue}</span>
                    </div>
                    <div className="ox-small">Proposed: {r.proposed}</div>
                    {r.note && <div className="ox-small ox-muted">“{r.note}”</div>}
                    {r.evidence && (
                      <a className="ox-link ox-small" href={r.evidence} target="_blank" rel="noopener noreferrer">
                        Evidence
                      </a>
                    )}
                    <div className="ox-row">
                      <Btn onClick={() => toast(`Asked reporter of ${r.id} for information`)}>Ask for information</Btn>
                      <Btn onClick={() => toast(`Rejected report ${r.id}`)}>Reject report</Btn>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="ox-grid2">
            <Field label="Product ID">
              <Input defaultValue="512330" inputMode="numeric" />
            </Field>
            <Field label="Quote variant">
              <Input defaultValue="holofoil" />
            </Field>
          </div>
          <details className="ox-details">
            <summary>Decision history ({HISTORY.length})</summary>
            <ol>
              {HISTORY.map((h) => (
                <li key={h.at} className="ox-small">
                  {h.at} · {h.what} — {h.why}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      {q === "attributes" && (
        <>
          <p className="ox-small">
            <Pill tone="new">No UI on dev today</Pill> Derived from TCGdex by rules v7. A correction overrides the source until the source changes.
          </p>
          <ScrollTable label="Attributes">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Derived</th>
                <th>Correction</th>
                <th>Effective</th>
              </tr>
            </thead>
            <tbody>
              {ATTRIBUTE_ROWS.map((r) => (
                <tr key={r.field} className={r.changed ? "ox-diff" : undefined}>
                  <td>{r.field}</td>
                  <td>{r.derived}</td>
                  <td>
                    {r.field === "Trainer Type" ? (
                      <Select options={["Supporter", "Item", "Tool", "Stadium", "Unknown"]} />
                    ) : (
                      r.correction
                    )}
                  </td>
                  <td>{r.effective}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          {item.reports > 0 && <p className="ox-small">{item.reports} linked collector report{item.reports > 1 ? "s" : ""} close with this decision.</p>}
        </>
      )}
      {q === "reprints" && (
        <>
          <p className="ox-small">
            <Pill tone="new">No UI on dev today</Pill> Card Identity <strong>Rare Candy</strong>. Copy limits count by Card Identity; legality flows through a Reprint Group.
          </p>
          <ScrollTable label="Reprint Groups">
            <thead>
              <tr>
                <th>Printing</th>
                <th>Mark</th>
                <th>Group</th>
                <th>Move to</th>
              </tr>
            </thead>
            <tbody>
              {REPRINT_GROUPS.flatMap((g, gi) =>
                g.printings.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.label} <span className="ox-muted">{p.id}</span>
                    </td>
                    <td>{p.mark}</td>
                    <td>
                      {gi + 1} <span className="ox-muted ox-small">{g.legal}</span>
                    </td>
                    <td>
                      <Select options={["Stay", gi === 0 ? "Group 2" : "Group 1", "New group"]} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </ScrollTable>
        </>
      )}
      {q === "missing" && (
        <>
          <p className="ox-small">
            <strong>{item.kind === "Edition" ? "Missing Edition" : "Missing Printing"}</strong> · reported by a collector {item.age} ago · <a className="ox-link" href="https://example.com/photo.jpg" target="_blank" rel="noopener noreferrer">Evidence</a>
          </p>
          <p className="ox-small ox-muted">“{item.kind === "Edition" ? "The Cosmos Holo from the 151 blister isn't listed." : "Special Illustration Rare is missing from Paldea Evolved."}”</p>
          <div className="ox-grid2">
            {item.kind === "Edition" ? (
              <>
                <Field label="Printing">
                  <Input defaultValue="Charmander · 151 · MEW 4" />
                </Field>
                <Field label="Variant Descriptor">
                  <Input defaultValue="Cosmos Holo" />
                </Field>
              </>
            ) : (
              <>
                <Field label="Verified set ID">
                  <Input defaultValue="sv02" />
                </Field>
                <Field label="Set name">
                  <Input defaultValue="Paldea Evolved" />
                </Field>
                <Field label="Collector number">
                  <Input defaultValue="269" />
                </Field>
                <Field label="Exact English name">
                  <Input defaultValue="Iono" />
                </Field>
              </>
            )}
            <Field label="Evidence link">
              <Input type="url" defaultValue="https://example.com/photo.jpg" />
            </Field>
          </div>
        </>
      )}
    </div>
  );
}
function ReasonField({ item }: { item: Item }) {
  return (
    <div className="ox-grid2">
      <Field label="Reason (kept on the record, and sent to the reporter when there is one)" wide>
        <Area rows={2} defaultValue="" placeholder="Why this decision is right" />
      </Field>
      {item.queue !== "missing" && (
        <Field label="Review evidence URL" wide>
          <Input type="url" placeholder="https://" />
        </Field>
      )}
    </div>
  );
}
/** Missing-card reviews: Request information and Reject need only a reason, as today; only Approve takes a code. */
function ReasonOnly({ item }: { item: Item }) {
  return (
    <div className="ox-row">
      <Btn onClick={() => decide(item, "Information requested")}>Request information</Btn>
      <Btn danger onClick={() => decide(item, "Report rejected")}>
        Reject
      </Btn>
    </div>
  );
}
/** The decision and its code, for A's inline card and C's decision bar. */
function DecideInline({ item, next }: { item: Item; next?: boolean }) {
  if (item.queue === "missing")
    return (
      <>
        <ReasonOnly item={item} />
        <CodeStep label={next ? "Approve & next" : "Approve shared record"} onConfirm={() => decide(item, "Approved shared record")} />
      </>
    );
  return (
    <>
      <Field label="Decision">
        <Select options={DECISIONS[item.queue]} />
      </Field>
      <CodeStep label={next ? "Confirm & next" : "Confirm decision"} onConfirm={() => decide(item, "Decision recorded")} />
    </>
  );
}

function PullPanel({ compact }: { compact?: boolean }) {
  const o = useOps();
  const r = PULL_STATES[o.pull];
  const busy = !r.outcome && !r.stale;
  const pct = Math.round((r.fetched / r.enumerated) * 100);
  return (
    <section className={`ox-panel${compact ? " ox-panel-compact" : ""}`} aria-label="Catalog pull">
      <div className="ox-row ox-between">
        <h3>English catalog pull</h3>
        <div className="ox-row">
          <Btn onClick={() => toast("Status refreshed")}>Refresh</Btn>
          <Btn primary disabled={busy} onClick={() => set({ pull: "running" })}>
            {r.stale ? "Restart pull" : "Start full pull"}
          </Btn>
        </div>
      </div>
      <p className="ox-small ox-muted">Last successful pull: {LAST_SUCCESS}</p>
      <div className="ox-row ox-small">
        <strong>Run {r.id}</strong>
        <Pill tone={r.stale ? "bad" : r.outcome ? "ok" : "warn"}>{r.stale ? "progress stale" : r.outcome ?? `${r.phase}…`}</Pill>
      </div>
      <div className="ox-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Fetched">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="ox-small ox-muted dx-num">
        Enumerated {r.enumerated.toLocaleString()} · Fetched {r.fetched.toLocaleString()} · Validated {r.validated.toLocaleString()}
      </p>
      {r.stale && (
        <p className="ox-small ox-warnline" role="status">
          Progress is stale. Restart the pull to check the runner and recover if it was interrupted.
        </p>
      )}
    </section>
  );
}
const toneOrder = { bad: 0, warn: 1, unverified: 2, ok: 3 } as const;
function HealthTable() {
  return (
    <ScrollTable label="Operational health">
      <thead>
        <tr>
          <th>Area</th>
          <th>Check</th>
          <th>Value</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {HEALTH.flatMap((g) =>
          g.rows.map((r) => (
            <tr key={r.label}>
              <td className="ox-muted">{g.group}</td>
              <td>{r.label}</td>
              <td>
                <Pill tone={r.tone}>{r.value}</Pill>
              </td>
              <td className="ox-muted">{r.detail ?? ""}</td>
            </tr>
          ))
        )}
      </tbody>
    </ScrollTable>
  );
}
const problems = () => HEALTH.flatMap((g) => g.rows).filter((r) => r.tone !== "ok").sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone]);
function ProblemLine() {
  return (
    <div className="ox-row ox-small" role="status">
      {problems().map((r: Health) => (
        <Pill key={r.label} tone={r.tone}>
          {r.label}: {r.value}
        </Pill>
      ))}
    </div>
  );
}
function RulesPanel() {
  return (
    <div className="ox-stack">
      <p className="ox-small ox-muted">Rules live in code. Activating a version records your approval of its exact code digest.</p>
      {RULES.map((r) => (
        <section key={r.kind} className="ox-panel">
          <div className="ox-row ox-between">
            <h3>{r.kind} rule</h3>
            <Pill tone={r.active === r.latest ? "ok" : "warn"}>{r.active === r.latest ? `v${r.active} active` : `v${r.active} active · v${r.latest} ready`}</Pill>
          </div>
          <p className="ox-small ox-muted">
            Digest {r.digest} · {r.note}
          </p>
          {r.active !== r.latest && <CodeStep label={`Activate v${r.latest}`} onConfirm={() => toast(`Activated ${r.kind} v${r.latest}`)} />}
        </section>
      ))}
    </div>
  );
}
function BeginRecord() {
  return (
    <details className="ox-details">
      <summary>Begin a record directly</summary>
      <div className="ox-grid2">
        <Field label="Record type">
          <Select options={["Printing", "Edition"]} />
        </Field>
        <Field label="Set ID">
          <Input />
        </Field>
        <Field label="Collector number">
          <Input />
        </Field>
        <Field label="Exact English name">
          <Input />
        </Field>
        <Field label="Evidence link">
          <Input type="url" />
        </Field>
      </div>
      <Btn onClick={() => toast("Owner record draft started")}>Begin record</Btn>
    </details>
  );
}

// ---------- collector: report form + thread ----------
function ReportForm({ guided }: { guided?: boolean }) {
  const [kind, setKind] = useState<"printing" | "edition">("printing");
  const [step, setStep] = useState(0);
  const [q, setQ] = useState("Charmander");
  const kindPicker = (
    <div className="ox-choice" role="radiogroup" aria-label="What is missing?">
      {(["printing", "edition"] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
          <strong>{k === "printing" ? "A whole card" : "A version of a card"}</strong>
          <span className="ox-small ox-muted">{k === "printing" ? "Missing Printing: the set and number aren't in the catalog." : "Missing Edition: the card is there, but not this finish, stamp or pattern."}</span>
        </button>
      ))}
    </div>
  );
  const identify =
    kind === "printing" ? (
      <div className="ox-grid2">
        <Field label="Set ID">
          <Input maxLength={80} placeholder="sv02" />
        </Field>
        <Field label="Set name">
          <Input maxLength={160} placeholder="Paldea Evolved" />
        </Field>
        <Field label="Collector number">
          <Input maxLength={80} placeholder="269" />
        </Field>
        <Field label="English name">
          <Input maxLength={160} placeholder="Iono" />
        </Field>
      </div>
    ) : guided ? (
      <div className="ox-stack">
        <Field label="Find the card" wide>
          <input className="ox-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <ul className="ox-pick">
          {PRINTING_SUGGESTIONS.filter((p) => p.toLowerCase().startsWith(q.toLowerCase())).map((p, i) => (
            <li key={p}>
              <label>
                <input type="radio" name="printing" defaultChecked={i === 0} /> {p}
              </label>
            </li>
          ))}
        </ul>
        <Field label="What's different about your copy?" wide>
          <Input placeholder="Finish, foil pattern, stamp, size…" />
        </Field>
      </div>
    ) : (
      <div className="ox-grid2">
        <Field label="Printing ID">
          <Input placeholder="sv3pt5-4" />
        </Field>
        <Field label="Physical variant details">
          <Input placeholder="Finish, foil pattern, stamp, size…" />
        </Field>
      </div>
    );
  const evidence = (
    <div className="ox-grid2">
      <Field label="Evidence link">
        <Input type="url" placeholder="https://" />
      </Field>
      <Field label="What is missing?" wide>
        <Area rows={3} maxLength={2000} />
      </Field>
    </div>
  );
  const send = () => {
    toast("Report sent privately to the owner");
    set({ newReport: false, myTab: "mine" });
    setStep(0);
  };
  if (guided) {
    const steps = ["What's missing", "Identify it", "Evidence"];
    return (
      <section className="ox-panel" aria-label="Report a missing card">
        <div className="ox-row ox-between">
          <h3>Report a missing card</h3>
          <ol className="ox-steps">
            {steps.map((t, i) => (
              <li key={t} aria-current={i === step ? "step" : undefined} className={i < step ? "ox-stepdone" : undefined}>
                <span>{i + 1}</span> {t}
              </li>
            ))}
          </ol>
        </div>
        {step === 0 ? kindPicker : step === 1 ? identify : evidence}
        <div className="ox-row ox-between">
          <span className="ox-small ox-muted">Private to you and the owner. A report doesn't add a catalog record.</span>
          <div className="ox-row">
            {step > 0 && <Btn onClick={() => setStep(step - 1)}>Back</Btn>}
            {step < 2 ? (
              <Btn primary onClick={() => setStep(step + 1)}>
                Next
              </Btn>
            ) : (
              <Btn primary onClick={send}>
                Send private report
              </Btn>
            )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <div className="ox-stack">
      <p className="ox-small ox-muted">Reports are private to you and the owner. They don't add a catalog record.</p>
      <Field label="Report type">
        <select className="ox-input" value={kind} onChange={(e) => setKind(e.target.value as "printing" | "edition")}>
          <option value="printing">Missing Printing</option>
          <option value="edition">Missing Edition</option>
        </select>
      </Field>
      {identify}
      {evidence}
      <div className="ox-row">
        <Btn primary onClick={send}>
          Send private report
        </Btn>
      </div>
    </div>
  );
}
const tone = (s: MyReport["status"]) => (s === "needs info" ? "warn" : s === "approved" ? "ok" : s === "rejected" ? "bad" : "neutral");
function Reply({ r }: { r: MyReport }) {
  return r.status === "needs info" ? (
    <div className="ox-stack">
      <Field label="Additional information" wide>
        <Area rows={2} />
      </Field>
      <div className="ox-row">
        <Btn primary onClick={() => toast("Information sent to the owner")}>
          Send information
        </Btn>
      </div>
    </div>
  ) : null;
}
function Thread({ r }: { r: MyReport }) {
  return (
    <ol className="ox-thread">
      {r.thread.map((m) => (
        <li key={m.at} className={`ox-msg ox-msg-${m.who}`}>
          <span className="ox-small ox-muted">
            {m.who === "you" ? "You" : "Owner"} · {m.at}
          </span>
          <p>{m.text}</p>
        </li>
      ))}
    </ol>
  );
}

// ---------- Variant A: sections + tables ----------
function OwnerA() {
  const o = useOps();
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: "status", label: "Status" },
    ...QUEUES.map((q) => ({ id: q.id as Tab, label: q.short, n: count(o, q.id) })),
    { id: "rules", label: "Rules" },
  ];
  return (
    <div className="ox ox-a">
      <ProblemLine />
      <div className="ox-tabscroll">
        <div className="dx-segs" role="tablist" aria-label="Owner controls sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-checked={o.tab === t.id} aria-selected={o.tab === t.id} onClick={() => set({ tab: t.id, open: null })}>
              {t.label}
              {t.n !== undefined && <span className="ox-count">{t.n}</span>}
            </button>
          ))}
        </div>
      </div>
      {o.tab === "status" ? (
        <>
          <PullPanel />
          <section className="ox-panel">
            <h3>Operational health</h3>
            <HealthTable />
          </section>
        </>
      ) : o.tab === "rules" ? (
        <RulesPanel />
      ) : (
        <QueueTableA q={o.tab} />
      )}
    </div>
  );
}
function QueueTableA({ q }: { q: QueueId }) {
  const o = useOps();
  const meta = QUEUES.find((x) => x.id === q)!;
  const rows = items(o, q);
  return (
    <section className="ox-stack" aria-label={meta.label}>
      <p className="ox-small ox-muted">
        {!meta.today && <Pill tone="new">No UI on dev today</Pill>} {meta.blurb}
      </p>
      {q === "missing" && <BeginRecord />}
      <div className="ox-scroll ox-cq" tabIndex={0} role="region" aria-label={`${meta.label}, scrolls sideways`}>
        <table className="ox-table">
          <thead>
            <tr>
              <th>Card</th>
              <th>Set · number</th>
              <th>Kind</th>
              <th>Reports</th>
              <th>Opened</th>
              <th>Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <RowA key={it.id} it={it} open={o.open === it.id} />
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="ox-muted">Nothing waiting.</p>}
      {q === "metadata" && !o.more && (
        <div>
          <Btn onClick={() => set({ more: true })}>Load more</Btn>
        </div>
      )}
    </section>
  );
}
function RowA({ it, open }: { it: Item; open: boolean }) {
  return (
    <>
      <tr className={open ? "ox-row-open" : undefined}>
        <td>
          <strong>{it.title}</strong> {it.flag && <Pill tone="warn">{it.flag}</Pill>}
        </td>
        <td>{it.sub}</td>
        <td>{it.kind}</td>
        <td className="dx-num">{it.reports || "—"}</td>
        <td>{it.opened}</td>
        <td>{it.age}</td>
        <td>
          <Btn onClick={() => set({ open: open ? null : it.id })}>{open ? "Close" : "Review"}</Btn>
        </td>
      </tr>
      {open && (
        <tr className="ox-detailrow">
          <td colSpan={7}>
            <div className="ox-pin">
              <ReviewBody item={it} />
              <ReasonField item={it} />
              <div className="ox-row ox-inlinedecide">
                <DecideInline item={it} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
function MissingA() {
  const o = useOps();
  const mine = MY_REPORTS.filter((r) => r.kind.startsWith("Missing"));
  return (
    <div className="ox ox-a">
      <div className="dx-segs" role="tablist" aria-label="Missing cards">
        <button type="button" role="tab" aria-checked={o.myTab === "mine"} aria-selected={o.myTab === "mine"} onClick={() => set({ myTab: "mine" })}>
          My reports <span className="ox-count">{mine.length}</span>
        </button>
        <button type="button" role="tab" aria-checked={o.myTab === "new"} aria-selected={o.myTab === "new"} onClick={() => set({ myTab: "new" })}>
          Report a card
        </button>
      </div>
      {o.myTab === "new" ? (
        <section className="ox-panel">
          <ReportForm />
        </section>
      ) : (
        <>
          <div className="ox-scroll ox-cq" tabIndex={0} role="region" aria-label="My reports, scrolls sideways">
            <table className="ox-table">
              <thead>
                <tr>
                  <th>Card</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Sent</th>
                  <th>Owner response</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => {
                  const owner = [...r.thread].reverse().find((m) => m.who === "owner");
                  const open = o.myOpen === r.id;
                  return (
                    <RowFrag key={r.id}>
                      <tr>
                        <td>
                          <strong>{r.card}</strong>
                        </td>
                        <td>{r.kind}</td>
                        <td>
                          <Pill tone={tone(r.status)}>{r.status}</Pill>
                        </td>
                        <td>{r.sent}</td>
                        <td className="ox-muted ox-clip">{owner?.text ?? "—"}</td>
                        <td>{r.status === "needs info" && <Btn onClick={() => set({ myOpen: open ? null : r.id })}>{open ? "Close" : "Reply"}</Btn>}</td>
                      </tr>
                      {open && (
                        <tr className="ox-detailrow">
                          <td colSpan={6}>
                            <div className="ox-pin">
                              <Thread r={r} />
                              <Reply r={r} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </RowFrag>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ox-small ox-muted">Metadata reports stay in Catalog's card popup, under My reports.</p>
        </>
      )}
    </div>
  );
}
const RowFrag = ({ children }: { children: ReactNode }) => <>{children}</>;

// ---------- Variant B: inbox ----------
export function OwnerSidebarB({ onPick }: { onPick?: () => void }) {
  const o = useOps();
  const entries: { id: Tab; label: string; n?: number; warn?: boolean }[] = [
    { id: "status", label: "Status", warn: problems().some((p) => p.tone === "bad") || PULL_STATES[o.pull].stale },
    ...QUEUES.map((q) => ({ id: q.id as Tab, label: q.label, n: count(o, q.id) })),
    { id: "rules", label: "Rules", n: RULES.filter((r) => r.active !== r.latest).length },
  ];
  return (
    <div className="ps-context ox-side">
      <div className="ps-context-head">
        <h2>Owner controls</h2>
      </div>
      <nav aria-label="Owner queues">
        {entries.map((e) => (
          <button key={e.id} type="button" aria-current={o.tab === e.id ? "page" : undefined} onClick={() => {
            set({ tab: e.id, open: null });
            onPick?.();
          }}>
            <span>{e.label}</span>
            {e.warn && <Pill tone="bad">!</Pill>}
            {!!e.n && <span className="ox-count">{e.n}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
function OwnerB() {
  const o = useOps();
  if (o.tab === "status")
    return (
      <div className="ox ox-b">
        <PullPanel />
        <section className="ox-panel">
          <h3>Operational health</h3>
          <ProblemLine />
          <HealthTable />
        </section>
      </div>
    );
  if (o.tab === "rules")
    return (
      <div className="ox ox-b">
        <RulesPanel />
      </div>
    );
  const q = o.tab;
  const meta = QUEUES.find((x) => x.id === q)!;
  const rows = items(o, q);
  const sel = rows.find((r) => r.id === o.open) ?? null;
  return (
    <div className={`ox ox-b ox-inbox${sel ? " ox-inbox-open" : ""}`}>
      <div className="ox-list">
        <p className="ox-small ox-muted">
          {!meta.today && <Pill tone="new">No UI on dev today</Pill>} {meta.blurb}
        </p>
        {q === "missing" && <BeginRecord />}
        <ul className="ox-msglist">
          {rows.map((it) => (
            <li key={it.id}>
              <button type="button" aria-current={sel?.id === it.id ? "true" : undefined} onClick={() => set({ open: it.id })}>
                <span className="ox-msgtop">
                  <strong>{it.title}</strong>
                  <span className="ox-muted ox-small">{it.age}</span>
                </span>
                <span className="ox-small ox-muted">
                  {it.sub} · {it.kind}
                  {it.reports ? ` · ${it.reports} report${it.reports > 1 ? "s" : ""}` : ""}
                </span>
                {it.flag && <Pill tone="warn">{it.flag}</Pill>}
              </button>
            </li>
          ))}
        </ul>
        {!rows.length && <p className="ox-muted">Nothing waiting.</p>}
        {q === "metadata" && !o.more && <Btn onClick={() => set({ more: true })}>Load more</Btn>}
      </div>
      <section className="ox-pane" aria-label="Review">
        {sel ? (
          <>
            <div className="ox-row ox-between ox-panehead">
              <button type="button" className="ox-link ox-back" onClick={() => set({ open: null })}>
                ‹ {meta.short}
              </button>
              <h3>
                {sel.title} <span className="ox-muted">{sel.sub}</span>
              </h3>
            </div>
            <ReviewBody item={sel} />
            <ReasonField item={sel} />
            <div className="ox-row ox-actions">
              {q === "missing" && <ReasonOnly item={sel} />}
              {(q === "missing" ? ["Approve shared record"] : DECISIONS[q].slice(0, 3)).map((d, i) => (
                <Btn key={d} primary={i === 0} onClick={() => set({ confirm: { item: sel, decision: d } })}>
                  {d}…
                </Btn>
              ))}
            </div>
          </>
        ) : (
          <p className="ox-muted ox-empty">Pick an item to review it.</p>
        )}
      </section>
      {o.confirm && <ConfirmDialog />}
    </div>
  );
}
function ConfirmDialog() {
  const o = useOps();
  const c = o.confirm!;
  return (
    <Dialog label="Confirm decision" onClose={() => set({ confirm: null })}>
      <p>
        <strong>{c.decision}</strong> for {c.item.title} {c.item.sub}.
      </p>
      <p className="ox-small ox-muted">This changes the shared catalog for every collector. Holdings don't move.</p>
      <CodeStep autoSent label="Confirm" onConfirm={() => decide(c.item, c.decision)} />
    </Dialog>
  );
}
function MissingB() {
  const o = useOps();
  const pick = (r: MyReport) =>
    o.myFilter === "all" ||
    (o.myFilter === "needs" && r.status === "needs info") ||
    (o.myFilter === "open" && r.status === "pending") ||
    (o.myFilter === "closed" && (r.status === "approved" || r.status === "rejected"));
  const list = MY_REPORTS.filter(pick).sort((a, b) => Number(b.status === "needs info") - Number(a.status === "needs info"));
  const sel = MY_REPORTS.find((r) => r.id === o.myOpen) ?? null;
  const filters = [
    ["all", "All", MY_REPORTS.length],
    ["needs", "Needs your reply", MY_REPORTS.filter((r) => r.status === "needs info").length],
    ["open", "Open", MY_REPORTS.filter((r) => r.status === "pending").length],
    ["closed", "Closed", MY_REPORTS.filter((r) => r.status === "approved" || r.status === "rejected").length],
  ] as const;
  return (
    <div className={`ox ox-b ox-inbox${sel ? " ox-inbox-open" : ""}`}>
      <div className="ox-list">
        <div className="ox-chips" role="radiogroup" aria-label="Show">
          {filters.map(([id, label, n]) => (
            <button key={id} type="button" role="radio" className="dx-fchip" aria-checked={o.myFilter === id} onClick={() => set({ myFilter: id })}>
              {label} {n}
            </button>
          ))}
        </div>
        <ul className="ox-msglist">
          {list.map((r) => (
            <li key={r.id}>
              <button type="button" aria-current={sel?.id === r.id ? "true" : undefined} onClick={() => set({ myOpen: r.id })}>
                <span className="ox-msgtop">
                  <strong>{r.card}</strong>
                  <Pill tone={tone(r.status)}>{r.status}</Pill>
                </span>
                <span className="ox-small ox-muted">
                  {r.kind} · {r.thread[r.thread.length - 1].text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section className="ox-pane" aria-label="Report">
        {sel ? (
          <>
            <div className="ox-row ox-between ox-panehead">
              <button type="button" className="ox-link ox-back" onClick={() => set({ myOpen: null })}>
                ‹ My reports
              </button>
              <h3>{sel.card}</h3>
            </div>
            <p className="ox-small">
              {sel.kind} · sent {sel.sent} · <Pill tone={tone(sel.status)}>{sel.status}</Pill>
            </p>
            <Thread r={sel} />
            <Reply r={sel} />
          </>
        ) : (
          <p className="ox-muted ox-empty">Every report you've sent — missing cards, metadata and attributes — lives here.</p>
        )}
      </section>
      {o.newReport && (
        <Dialog label="Report a missing card" onClose={() => set({ newReport: false })}>
          <ReportForm />
        </Dialog>
      )}
    </div>
  );
}

// ---------- Variant C: dashboard + focused review ----------
function OwnerC() {
  const o = useOps();
  if (o.drill) return <FocusC />;
  const r = PULL_STATES[o.pull];
  return (
    <div className="ox ox-c">
      <h4 className="ox-h">Needs you</h4>
      <div className="ox-tiles">
        {QUEUES.map((q) => {
          const rows = items(o, q.id);
          return (
            <button key={q.id} type="button" className="ox-tile" onClick={() => set({ drill: q.id, idx: 0 })} disabled={!rows.length}>
              <span className="ox-tilen dx-num">{rows.length}</span>
              <strong>{q.label}</strong>
              <span className="ox-small ox-muted">{rows.length ? `oldest ${rows[rows.length - 1].age}` : "clear"}</span>
              {!q.today && <Pill tone="new">No UI today</Pill>}
            </button>
          );
        })}
        <button type="button" className="ox-tile" onClick={() => set({ drill: "rules" })}>
          <span className="ox-tilen dx-num">{RULES.filter((x) => x.active !== x.latest).length}</span>
          <strong>Rule versions ready</strong>
          <span className="ox-small ox-muted">marketplace v4</span>
        </button>
      </div>
      <h4 className="ox-h">Status</h4>
      <div className="ox-tiles ox-tiles-status">
        <div className={`ox-tile ox-tile-static ox-t-${r.stale ? "bad" : r.outcome ? "ok" : "warn"}`}>
          <strong>Catalog pull · run {r.id}</strong>
          <div className="ox-bar">
            <span style={{ width: `${Math.round((r.fetched / r.enumerated) * 100)}%` }} />
          </div>
          <span className="ox-small ox-muted">{r.stale ? "Progress stale" : r.outcome ? `Done · last success ${LAST_SUCCESS}` : `${r.phase} · ${r.fetched.toLocaleString()} / ${r.enumerated.toLocaleString()}`}</span>
          <div className="ox-row">
            <Btn primary disabled={!r.outcome && !r.stale} onClick={() => set({ pull: "running" })}>
              {r.stale ? "Restart" : "Start full pull"}
            </Btn>
          </div>
        </div>
        {HEALTH.map((g) => {
          const worst = [...g.rows].sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone])[0];
          return (
            <details key={g.group} className={`ox-tile ox-tile-static ox-t-${worst.tone}`}>
              <summary>
                <strong>{g.group}</strong>
                <span className="ox-small">
                  {worst.tone === "ok" ? "All good" : `${worst.label}: ${worst.value}`}
                </span>
              </summary>
              <ul className="ox-small">
                {g.rows.map((x) => (
                  <li key={x.label}>
                    {x.label}: <Pill tone={x.tone}>{x.value}</Pill> <span className="ox-muted">{x.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </div>
  );
}
function FocusC() {
  const o = useOps();
  const back = (
    <button type="button" className="ox-link ox-back" onClick={() => set({ drill: null })}>
      ‹ Owner controls
    </button>
  );
  if (o.drill === "rules")
    return (
      <div className="ox ox-c">
        {back}
        <RulesPanel />
      </div>
    );
  const q = o.drill!;
  const meta = QUEUES.find((x) => x.id === q)!;
  const rows = items(o, q);
  const i = Math.min(o.idx, rows.length - 1);
  const it = rows[i];
  if (!it)
    return (
      <div className="ox ox-c">
        {back}
        <p>
          <strong>{meta.label}</strong> is clear.
        </p>
      </div>
    );
  return (
    <div className="ox ox-c ox-focus">
      <div className="ox-row ox-between">
        {back}
        <div className="ox-row">
          <span className="ox-small dx-num">
            {meta.short} · {i + 1} of {rows.length}
            {q === "metadata" && !o.more ? "+" : ""}
          </span>
          <Btn onClick={() => set({ idx: Math.max(0, i - 1) })} disabled={i === 0}>
            ‹
          </Btn>
          <Btn
            onClick={() => (i === rows.length - 1 && q === "metadata" && !o.more ? set({ more: true, idx: i + 1 }) : set({ idx: Math.min(rows.length - 1, i + 1) }))}
            disabled={i === rows.length - 1 && (q !== "metadata" || o.more)}
          >
            Skip ›
          </Btn>
        </div>
      </div>
      <h2 className="ox-title">
        {it.title} <span className="ox-muted">{it.sub}</span> {it.flag && <Pill tone="warn">{it.flag}</Pill>}
      </h2>
      {!meta.today && <Pill tone="new">No UI on dev today</Pill>}
      <ReviewBody item={it} />
      <ReasonField item={it} />
      <div className="ox-decbar">
        <DecideInline item={it} next />
      </div>
    </div>
  );
}
function MissingC() {
  const sorted = [...MY_REPORTS.filter((r) => r.kind.startsWith("Missing"))].sort((a, b) => Number(b.status === "needs info") - Number(a.status === "needs info"));
  return (
    <div className="ox ox-c">
      <ReportForm guided />
      <h4 className="ox-h">Your reports</h4>
      <div className="ox-cards">
        {sorted.map((r) => (
          <article key={r.id} className={`ox-card${r.status === "needs info" ? " ox-card-hot" : ""}`}>
            <div className="ox-row ox-between">
              <strong>{r.card}</strong>
              <Pill tone={tone(r.status)}>{r.status}</Pill>
            </div>
            <span className="ox-small ox-muted">
              {r.kind} · sent {r.sent}
            </span>
            <ol className="ox-timeline ox-small">
              {r.thread.map((m) => (
                <li key={m.at}>
                  <strong>{m.who === "you" ? "You" : "Owner"}:</strong> {m.text}
                </li>
              ))}
            </ol>
            <Reply r={r} />
          </article>
        ))}
      </div>
    </div>
  );
}

// ---------- dialog + toast ----------
function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="dx-scrim" onClick={onClose} />
      <div className="dx-modal ox-modal" role="dialog" aria-modal="true" aria-label={label}>
        <div className="dx-modal-head">
          <strong>{label}</strong>
          <span className="dx-spacer" />
          <button type="button" className="dx-icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
function Toast() {
  const o = useOps();
  return o.toast ? (
    <div className="dx-toast ox-toast" role="status">
      {o.toast}
      <button type="button" className="ox-link" onClick={() => set({ toast: null })}>
        Dismiss
      </button>
    </div>
  ) : null;
}

// ---------- exports for the shell ----------
export function MissingCardsPage() {
  const o = useOps();
  return (
    <>
      {o.variant === "A" ? <MissingA /> : o.variant === "B" ? <MissingB /> : <MissingC />}
      <Toast />
    </>
  );
}
export function OwnerControlsPage() {
  const o = useOps();
  return (
    <>
      {o.variant === "A" ? <OwnerA /> : o.variant === "B" ? <OwnerB /> : <OwnerC />}
      <Toast />
    </>
  );
}
export function OpsPageActions({ s }: { s: Shell }) {
  const o = useOps();
  if (s.page === "reports" && o.variant === "B")
    return (
      <button type="button" className="ps-btn ps-btn-primary" onClick={() => set({ newReport: true })}>
        Report a missing card
      </button>
    );
  if (s.page === "owner" && o.variant !== "C")
    return (
      <button type="button" className="ps-btn" onClick={() => toast("Refreshed")}>
        Refresh
      </button>
    );
  return null;
}
export function OpsVariantPicker() {
  const o = useOps();
  return (
    <>
      <label>
        ops{" "}
        <select value={o.variant} onChange={(e) => setOpsVariant(e.target.value as OpsVariant)}>
          {OPS_VARIANTS.map((v) => (
            <option key={v.key} value={v.key}>
              {v.key} ({v.name})
            </option>
          ))}
        </select>
      </label>
      <label>
        pull{" "}
        <select value={o.pull} onChange={(e) => set({ pull: e.target.value as Pull })}>
          <option value="running">running</option>
          <option value="stale">stale</option>
          <option value="done">done</option>
        </select>
      </label>
    </>
  );
}
/** Read outside React (the shell's contextFor); the shell root subscribes with useOps so it re-renders. */
export const ownerHasSidebar = () => state.variant === "B";
