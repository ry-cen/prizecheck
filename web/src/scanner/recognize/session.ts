// The worker's voting session: turns frame results, shutter presses and lock outcomes into the messages the main thread
// sees. Pure (no clock, no worker globals), so the message-level rules are unit-tested without models.
import type { FromWorker, ToWorker } from "../worker/messages";
import { Voter } from "./vote";
import type { VoteEvent, VoteFrame } from "./vote";

export class VoteSession {
  readonly voter = new Voter();
  private shutterWaiting = false;

  get state() {
    return this.voter.state;
  }

  /** True when the next analysed frame answers a shutter press. Reading it consumes the press. */
  takeShutter(): boolean {
    const s = this.shutterWaiting;
    this.shutterWaiting = false;
    return s;
  }

  /** The shutter press: a lock from the current window, or a request for the next frame to decide. */
  shutter(t: number): FromWorker[] {
    const r = this.voter.onShutter(t);
    if (r === "needFrame") {
      this.shutterWaiting = true;
      return [];
    }
    return toMessages(r);
  }

  /** The vote for one analysed frame. `shutterFrame`: the frame was taken to answer a shutter press. */
  frame(vf: VoteFrame, shutterFrame: boolean): FromWorker[] {
    if (shutterFrame) return toMessages(this.voter.onShutterFrame(vf));
    const r = this.voter.onFrame(vf);
    const out = toMessages(r.event);
    if (r.absentLockId !== null)
      out.push({ t: "absent", lockId: r.absentLockId });
    return out;
  }

  outcome(m: Extract<ToWorker, { t: "lockOutcome" }>, t: number): void {
    this.voter.onOutcome(m.lockId, m.added, m.reason, t);
  }
}

function toMessages(e: VoteEvent | null): FromWorker[] {
  if (!e) return [];
  if (e.kind === "lock")
    return [
      { t: "lock", lockId: e.lockId, printingIds: e.printingIds, via: e.via },
    ];
  return [{ t: "miss" }];
}
