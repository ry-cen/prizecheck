import { useEffect, useRef, useState } from "react";
import {
  getTradeWants,
  setTradeWant,
  setWillAccept,
  TradesError,
  type TradeWantLine,
  type TradeWants,
} from "../trades_generated";
import { useToast } from "../ui/Toast";
import {
  rulesOf,
  tradeWantsRefusal,
  willAcceptToast,
  type WillAcceptRule,
} from "./tradeWantsModel";

type Card = Omit<TradeWantLine, "quantity">;

export type TradeWantsState =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      wants: TradeWants;
      /** Each widened Will accept choice by Card Edition id. */
      rules: Map<string, WillAcceptRule>;
    };

export type TradeWantsApi = {
  state: TradeWantsState;
  /** A change is on its way: every Trade Wants and Will accept control ignores presses until it lands. */
  busy: boolean;
  /** Why the last Trade Wants change wasn't made, or "". */
  refusal: string;
  clearRefusal: () => void;
  /** Sets a line to `quantity` copies ("0" removes it). Resolves true when it was saved. */
  setQuantity: (
    card: Card,
    quantity: number,
    toast?: "added"
  ) => Promise<boolean>;
  /** The Will accept choice being saved, shown by its select until the answer lands or fails. */
  pendingRule: { edition_id: string; rule: WillAcceptRule } | null;
  setRule: (card: Card, rule: WillAcceptRule) => void;
  retry: () => void;
};

/**
 * The collector's own Trade Wants and Will accept choices on the Want List page (Trading #275), from
 * GET /api/trade-wants. One change at a time: each setter answers the whole list, which replaces the one shown, so a
 * slow answer can never overwrite a newer one. A Will accept change reads the Want List again (`onRulesChanged`),
 * because the Swap hints follow it; a Trade Wants change moves no Want List figure, so it doesn't.
 */
export function useTradeWants(onRulesChanged: () => void): TradeWantsApi {
  const kit = useToast();
  const [state, setState] = useState<TradeWantsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const [pendingRule, setPendingRule] =
    useState<TradeWantsApi["pendingRule"]>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const live = useRef(onRulesChanged);
  live.current = onRulesChanged;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function ready(wants: TradeWants) {
    if (mounted.current)
      setState({ kind: "ready", wants, rules: rulesOf(wants) });
  }

  useEffect(() => {
    const controller = new AbortController();
    getTradeWants(controller.signal)
      .then(ready)
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      });
    return () => controller.abort();
  }, [attempt]);

  async function run(work: () => Promise<TradeWants>): Promise<TradeWants> {
    working.current = true;
    setBusy(true);
    try {
      const wants = await work();
      ready(wants);
      return wants;
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function setQuantity(
    card: Card,
    quantity: number,
    toast?: "added"
  ): Promise<boolean> {
    if (working.current) return false;
    setRefusal("");
    try {
      await run(() =>
        setTradeWant(card.edition_id, { quantity: String(quantity) })
      );
      if (toast === "added") kit.show({ message: "Added to Trade Wants" });
      else if (quantity === 0)
        kit.show({ message: "Removed from Trade Wants" });
      return true;
    } catch (cause) {
      if (mounted.current)
        setRefusal(
          tradeWantsRefusal(
            cause instanceof TradesError && cause.status < 500
              ? cause.code
              : null
          )
        );
      return false;
    }
  }

  async function setRule(card: Card, rule: WillAcceptRule) {
    if (working.current) return;
    setPendingRule({ edition_id: card.edition_id, rule });
    try {
      await run(() => setWillAccept(card.edition_id, { rule }));
      kit.show({ message: willAcceptToast(rule, card) });
    } catch {
      kit.show({
        message: "That choice couldn't be saved. Please try again.",
      });
    } finally {
      if (mounted.current) {
        setPendingRule(null);
        live.current();
      }
    }
  }

  return {
    state,
    busy,
    refusal,
    pendingRule,
    clearRefusal: () => setRefusal(""),
    setQuantity,
    setRule: (card, rule) => void setRule(card, rule),
    retry: () => {
      setState({ kind: "loading" });
      setAttempt((n) => n + 1);
    },
  };
}
