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
  private paused = false;
  private needsReload = false;
  private refused = false;
  private isolate = new Set<string>();
  private reconcile(fresh: DeckDetail, refusal = false) {
    let dropped = false;
    for (const id of this.totals.keys()) {
      if (
        (this.detail.lines.find((l) => l.edition.id === id)?.quantity ?? 0) !==
        (fresh.lines.find((l) => l.edition.id === id)?.quantity ?? 0)
      ) {
        this.totals.delete(id);
        this.isolate.delete(id);
        dropped = true;
      }
    }
    this.installDetail(fresh);
    if (dropped) {
      this.paused = true;
      this.error = refusal
        ? "That card can't be added any more, and this Deck changed, so some changes weren’t saved. Review the Deck List."
        : "This Deck changed, so some changes weren’t saved. Review the Deck List.";
    }
    return dropped;
  }
  constructor(
    public detail: DeckDetail,
    private writer: Pick<DeckWriter, "owner" | "changeDeckList">,
    private changed: () => void
  ) {}
  acceptLocation(location: DeckDetail["location"]) {
    if (
      !this.alive ||
      location.id !== this.detail.location.id ||
      location.version <= this.detail.location.version
    )
      return;
    this.detail = { ...this.detail, location };
    this.changed();
  }
  private installDetail(detail: DeckDetail) {
    const location =
      this.detail.location.version > detail.location.version
        ? this.detail.location
        : detail.location;
    this.detail =
      detail.listRevision >= this.detail.listRevision
        ? { ...detail, location }
        : { ...this.detail, location };
  }
  acceptRead(detail: DeckDetail) {
    if (!this.alive || this.detail === detail) return;
    this.acceptLocation(detail.location);
    if (this.busy) return;
    this.installDetail(detail);
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
    return this.paused && this.totals.size > 0;
  }
  adjust(id: string, delta: number) {
    if (!this.alive) return;
    if (!this.paused) {
      this.error = "";
      this.refused = false;
    }
    this.totals.set(id, Math.max(0, this.quantity(id) + delta));
    this.changed();
    if (!this.paused) void this.flush();
  }
  retry() {
    if (this.alive && !this.running && this.canRetry) {
      this.error = "";
      this.paused = false;
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
    let baseline = this.detail;
    try {
      if (this.needsReload) {
        const fresh = await this.writerRead();
        if (!this.alive) return;
        if (!fresh) throw new DeckError("DECK_NOT_FOUND");
        const dropped = this.reconcile(fresh, true);
        this.needsReload = false;
        if (dropped || !this.totals.size) return;
      }
      baseline = this.detail;
      this.attempt ??= {
        input: {
          deckId: this.detail.location.id,
          listRevision: this.detail.listRevision,
          changes: (() => {
            const all = [...this.totals];
            const normal = all.filter(([id]) => !this.isolate.has(id));
            return normal.length ? normal : all.slice(0, 1);
          })().map(([editionId, quantity]) => ({
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
      const result = await this.writer.changeDeckList(sent.input, {
        signal: this.controller.signal,
        idempotencyKey: sent.key,
      });
      if (!this.alive) return;
      this.installDetail(result);
      for (const c of sent.input.changes) {
        if (this.totals.get(c.editionId) === c.quantity)
          this.totals.delete(c.editionId);
        this.isolate.delete(c.editionId);
      }
      this.attempt = undefined;
      if (this.refused && !this.totals.size)
        this.error =
          "That card can't be added any more. Your other changes were saved.";
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
          this.installDetail(fresh);
          if (!unchanged) {
            this.totals.clear();
            this.isolate.clear();
          }
          this.attempt = undefined;
          this.paused = unchanged;
          this.error = unchanged
            ? "This Deck changed, so your last change wasn't saved. It's up to date now: try again."
            : "This Deck changed, so your last change wasn't saved. Review the refreshed Deck List.";
        } catch {
          if (this.alive) {
            this.paused = true;
            this.error =
              "Your last Deck List change may not have been saved. Try again to check safely.";
          }
        }
      } else if (e instanceof DeckError && e.code === "EDITION_UNAVAILABLE") {
        // The batch failed atomically and the refusal names no Edition
        // (api/app/games/pokemon/decks/routes.py:268-278). Every sent
        // nonzero line absent from the baseline could be the cause,
        // whatever the collector has queued for it since.
        const candidates = this.attempt!.input.changes.filter(
          (change) =>
            change.quantity > 0 &&
            !baseline.lines.some((line) => line.edition.id === change.editionId)
        ).map((change) => change.editionId);
        if (candidates.length === 1) {
          // Certainly unavailable: any nonzero re-add would be refused again.
          this.totals.delete(candidates[0]);
          this.isolate.delete(candidates[0]);
        } else
          for (const id of candidates) {
            if ((this.totals.get(id) ?? 0) === 0) {
              this.totals.delete(id);
              this.isolate.delete(id);
            } else this.isolate.add(id);
          }
        this.attempt = undefined;
        this.refused = true;
        this.needsReload = true;
        this.error = this.totals.size
          ? "That card can't be added any more. Your other changes are still being saved."
          : "That card can't be added any more. Review the Deck List.";
        try {
          const fresh = await this.writerRead();
          if (!this.alive) return;
          if (!fresh) throw new DeckError("DECK_NOT_FOUND");
          this.reconcile(fresh, true);
          this.needsReload = false;
        } catch {
          if (this.alive && this.totals.size) {
            this.paused = true;
            this.error =
              "That card can't be added any more. Your other changes haven't been saved. Try again to reload and save them.";
          }
        }
      } else {
        this.paused = true;
        this.error =
          "Your last Deck List change may not have been saved. Try again to check safely.";
      }
    } finally {
      if (this.alive) {
        this.running = false;
        this.changed();
        if (!this.paused) void this.flush();
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
