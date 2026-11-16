import { DeckError, type DeckDetail, type DeckWriter } from "./decks";
/** A single Deck's write queue. Pending totals are absolute; clicks during a request accumulate against the visible total. */
export class DeckEdits {
  private alive = true;
  private controller = new AbortController();
  private totals = new Map<string, number>();
  private attempt?: {
    input: Parameters<DeckWriter["changeDeckList"]>[0];
    key: string;
  };
  private running = false;
  error = "";
  constructor(
    public detail: DeckDetail,
    private writer: Pick<DeckWriter, "owner" | "changeDeckList">,
    private changed: () => void
  ) {}
  acceptRead(detail: DeckDetail) {
    if (!this.alive || this.detail === detail) return;
    if (this.busy) {
      if (detail.location.version > this.detail.location.version) {
        this.detail = { ...this.detail, location: detail.location };
        this.changed();
      }
      return;
    }
    this.detail = detail;
    this.changed();
  }
  quantity(id: string) {
    return (
      this.totals.get(id) ??
      this.detail.lines.find((l) => l.edition.id === id)?.quantity ??
      0
    );
  }
  get busy() {
    return this.running || this.totals.size > 0;
  }
  get canRetry() {
    return !!this.error && this.totals.size > 0;
  }
  adjust(id: string, delta: number) {
    if (!this.alive) return;
    if (!this.canRetry) this.error = "";
    this.totals.set(id, Math.max(0, this.quantity(id) + delta));
    this.changed();
    if (!this.error) void this.flush();
  }
  retry() {
    if (this.alive && !this.running && this.canRetry) {
      this.error = "";
      this.changed();
      void this.flush();
    }
  }
  dispose() {
    this.alive = false;
    this.controller.abort();
  }
  private async flush() {
    if (this.running || !this.alive || !this.totals.size) return;
    this.running = true;
    this.attempt ??= {
      input: {
        deckId: this.detail.location.id,
        listRevision: this.detail.listRevision,
        changes: [...this.totals].map(([editionId, quantity]) => ({
          editionId,
          quantity,
        })),
      },
      key: JSON.stringify([
        "riftbound",
        this.writer.owner,
        crypto.randomUUID(),
      ]),
    };
    const sent = this.attempt;
    const baseline = this.detail;
    this.changed();
    try {
      const result = await this.writer.changeDeckList(sent.input, {
        signal: this.controller.signal,
        idempotencyKey: sent.key,
      });
      if (!this.alive) return;
      this.detail = {
        ...result,
        location:
          this.detail.location.version > result.location.version
            ? this.detail.location
            : result.location,
      };
      for (const c of sent.input.changes)
        if (this.totals.get(c.editionId) === c.quantity)
          this.totals.delete(c.editionId);
      this.attempt = undefined;
    } catch (e) {
      if (!this.alive) return;
      if (e instanceof DeckError && e.code === "STALE_DECK_LIST") {
        try {
          const fresh = await this.writerRead();
          if (!this.alive) return;
          if (!fresh) throw new DeckError("DECK_NOT_FOUND");
          const unchanged = [...this.totals.keys()].every(
            (id) =>
              (baseline.lines.find((line) => line.edition.id === id)
                ?.quantity ?? 0) ===
              (fresh.lines.find((line) => line.edition.id === id)?.quantity ??
                0)
          );
          this.detail = fresh;
          if (!unchanged) this.totals.clear();
          this.attempt = undefined;
          this.error = unchanged
            ? "This Deck changed somewhere else, so your last change wasn't saved. It's up to date now: try again."
            : "This Deck changed somewhere else, so your last change wasn't saved. Review the refreshed Deck List.";
        } catch {
          if (this.alive)
            this.error =
              "Your last Deck List change may not have been saved. Try again to check safely.";
        }
      } else if (e instanceof DeckError && e.code === "EDITION_UNAVAILABLE") {
        this.attempt = undefined;
        this.totals.clear();
        this.error =
          "That card can't be added any more, so the Deck List wasn't changed.";
        try {
          const fresh = await this.writerRead();
          if (this.alive && fresh) this.detail = fresh;
        } catch {
          // The refusal is definitive even when its follow-up read fails.
        }
      } else {
        this.error =
          "Your last Deck List change may not have been saved. Try again to check safely.";
      }
    } finally {
      if (this.alive) {
        this.running = false;
        this.changed();
        if (!this.error) void this.flush();
      }
    }
  }
  // Reader is attached explicitly; no generated client or network access.
  reload?: (signal: AbortSignal) => Promise<DeckDetail | null>;
  private writerRead() {
    if (!this.reload) return Promise.reject(new Error("No reader"));
    return this.reload(this.controller.signal);
  }
}
