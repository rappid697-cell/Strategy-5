from typing import Dict, Any

# ─────────────────────────────────────────────────────────────────────────────
#  Latency-arb entry engine.
#
#  Backtest verdict: the model has NO predictive edge over the trivial "is spot
#  already above the 15m open?" baseline — that signal is fully priced by the
#  market. The only edge left is LATENCY: act on a Binance spot move before
#  Polymarket's thin book reprices.
#
#  The decision is purely a fast fair probability (from Binance spot) vs the
#  market's implied price. Enter when the gap (expected value) is large enough
#  that the book looks stale. There are no other filters.
# ─────────────────────────────────────────────────────────────────────────────


def _no_ev(reason: str, side=None, prob=None, price=None, ev=None) -> Dict[str, Any]:
    # Carry the chosen side's prob/price/ev even on a no-trade so every tick can be
    # logged and mined for filters later.
    return {"action": "NO_TRADE", "side": side, "phase": "EV", "strength": "EV",
            "reason": reason, "prob": prob, "price": price, "ev": ev}


def decide_ev(inputs: Dict[str, Any]) -> Dict[str, Any]:
    """EV gate: fair probability (Binance) vs market ask price (Polymarket).

    EV_side = p_side - ask_price_side. A positive EV beyond `evThreshold` means the
    book is underpricing the side our fast feed already favours — the latency edge.
    Position sizing (percent/fixed of balance) is handled by the caller.
    """
    p_up = inputs.get("mcProbUp")
    price_up = inputs.get("priceUp")     # ask (buy) price for the UP share, 0..1
    price_down = inputs.get("priceDown") # ask (buy) price for the DOWN share, 0..1

    if p_up is None:
        return _no_ev("missing_model_data")
    if price_up is None or price_down is None:
        return _no_ev("missing_prices")

    p_down = 1.0 - p_up
    ev_up = p_up - price_up
    ev_down = p_down - price_down

    side = "UP" if ev_up >= ev_down else "DOWN"
    p = p_up if side == "UP" else p_down
    price = price_up if side == "UP" else price_down
    ev = ev_up if side == "UP" else ev_down

    min_prob = inputs.get("minProb", 0.55)
    ev_threshold = inputs.get("evThreshold", 0.04)

    # ── GATES ──
    if p < min_prob:
        return _no_ev(f"prob_{p:.2f}_below_{min_prob:.2f}", side, p, price, ev)
    if ev < ev_threshold:
        return _no_ev(f"ev_{ev:.3f}_below_{ev_threshold:.3f}", side, p, price, ev)

    strength = "HIGH_CONVICTION" if p >= 0.70 else "STRONG"
    return {
        "action": "ENTER", "side": side, "phase": "EV", "strength": strength,
        "prob": p, "price": price, "ev": ev, "reason": "ev_enter"
    }


# ─────────────────────────────────────────────────────────────────────────────
#  CUSUM Change-Point entry engine (this build's UNIQUE logic).
#
#  This is an *event-triggered* engine: it does nothing until an accumulated
#  directional-evidence score crosses a threshold, then fires ONCE. It trades the
#  moment the market flips direction — before Polymarket fully reprices — not a
#  standing view. The accumulators (S+/S-) are maintained across ticks in the
#  main loop; this function only turns a fired change-point into an ENTER/NO_TRADE
#  decision, gating on a non-negative edge vs the market ask so we don't chase a
#  turn the book has already priced.
# ─────────────────────────────────────────────────────────────────────────────

def decide_cusum(inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Change-point entry: enter ONLY when a CUSUM accumulator has crossed H.

    `changePoint` is "UP"/"DOWN" (the accumulator that crossed this tick) or None.
    On a crossing we still require the crossed side to have a non-negative edge
    (EV = fair_prob - ask_price >= evThreshold, default 0.0) — a detected turn the
    book already reflects is not tradeable. With no crossing we never enter, even
    if a standing EV edge exists (that's what makes this the "trade the turn" bot).
    """
    change_point = inputs.get("changePoint")   # "UP" | "DOWN" | None
    p_up = inputs.get("mcProbUp")
    price_up = inputs.get("priceUp")
    price_down = inputs.get("priceDown")
    s_plus = inputs.get("sPlus")
    s_minus = inputs.get("sMinus")
    # min edge to act on a crossing; non-negative by default (spec: "non-negative EV")
    ev_threshold = inputs.get("evThreshold", 0.0)

    def _no(reason, side=None, prob=None, price=None, ev=None):
        return {"action": "NO_TRADE", "side": side, "phase": "CUSUM", "strength": "CUSUM",
                "reason": reason, "prob": prob, "price": price, "ev": ev,
                "sPlus": s_plus, "sMinus": s_minus, "changePoint": change_point}

    if p_up is None:
        return _no("missing_model_data")
    if price_up is None or price_down is None:
        return _no("missing_prices")

    p_down = 1.0 - p_up

    if not change_point:
        sp = s_plus if s_plus is not None else 0.0
        sm = s_minus if s_minus is not None else 0.0
        return _no(f"no_change_point(S+={sp:.2f},S-={sm:.2f})")

    side = change_point
    p = p_up if side == "UP" else p_down
    price = price_up if side == "UP" else price_down
    ev = p - price

    # ── EDGE GATE ── only trade the turn if the book hasn't already priced it.
    if ev < ev_threshold:
        return _no(f"changepoint_{side}_ev_{ev:.3f}_below_{ev_threshold:.3f}", side, p, price, ev)

    strength = "HIGH_CONVICTION" if p >= 0.70 else "STRONG"
    return {
        "action": "ENTER", "side": side, "phase": "CUSUM", "strength": strength,
        "prob": p, "price": price, "ev": ev, "reason": f"cusum_changepoint_{side}",
        "sPlus": s_plus, "sMinus": s_minus, "changePoint": change_point
    }
