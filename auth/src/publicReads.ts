import { createHmac, randomBytes } from "node:crypto";

/** Local gateway boundary. Only short-lived salted digests are held in memory;
 * no client IP or request log is written to application storage. Production
 * edge/provider selection must enforce the same budget across replicas. */
export class PublicReadLimiter {
  private window = -1;
  private salt = randomBytes(32);
  private counts = new Map<string, number>();

  constructor(
    private limit = 120,
    private maxCallers = 10_000
  ) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(maxCallers) ||
      maxCallers < 1
    )
      throw new Error("Invalid public read budget");
  }

  take(clientIp: string, now = Date.now()): boolean {
    const window = Math.floor(now / 60_000);
    if (window !== this.window) {
      this.window = window;
      this.salt = randomBytes(32);
      this.counts.clear();
    }
    const key = createHmac("sha256", this.salt).update(clientIp).digest("hex");
    const used = this.counts.get(key) ?? 0;
    if (
      used >= this.limit ||
      (!this.counts.has(key) && this.counts.size >= this.maxCallers)
    )
      return false;
    this.counts.set(key, used + 1);
    return true;
  }

  retryAfter(now = Date.now()): number {
    return Math.max(
      1,
      Math.ceil(((Math.floor(now / 60_000) + 1) * 60_000 - now) / 1000)
    );
  }
}
