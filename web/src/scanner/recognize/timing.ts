import type { Stage } from "../worker/messages";

/** Per-frame stage timer. `lap` adds the time since the previous lap (or `begin`) to a stage; repeats sum. */
export class StageTimer {
  readonly ms: Partial<Record<Stage, number>> = {};
  private t0 = 0;
  private last = 0;

  begin(): void {
    this.t0 = this.last = performance.now();
  }

  lap(stage: Stage): void {
    const now = performance.now();
    this.ms[stage] = (this.ms[stage] ?? 0) + (now - this.last);
    this.last = now;
  }

  end(): void {
    this.ms.total = performance.now() - this.t0;
  }
}
