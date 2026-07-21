# 4 — CUSUM Change-Point Trigger

**Type:** Entry engine (regime-transition / "trade the turn" bot).

**Distinct from the others:** the only *event-triggered* engine — it does nothing
until an accumulated score crosses a threshold, then fires once. #3 Fast/Slow is
always-on and continuous; this is the tripwire. It trades the *moment of change*,
not a standing view.

## Idea
Accumulate a directional-evidence score and fire when it crosses a threshold —
catch the moment the market flips direction, before Polymarket fully reprices.

## Entry rule
```
Z_t  = w1·futures_lead + w2·spot_disagreement + w3·order_flow
       + w4·oracle_gap_accel + w5·(q_fast − q_slow)

S⁺_t = max(0, S⁺_{t−1} + Z_t − k)     # large positive  → upward shift → consider UP
S⁻_t = min(0, S⁻_{t−1} + Z_t + k)     # large negative  → downward shift → consider DOWN

if S⁺_t >= H:  upward change-point   → enter UP if all-in edge positive
if S⁻_t <= −H: downward change-point → enter DOWN if all-in edge positive
```
- `k` = slack (drift allowance), `H` = decision threshold. Both learned.

## Inputs needed
- Multi-venue features (futures lead, cross-venue dispersion, order flow).
- Optionally the fast/slow probabilities from **3**.

## Standalone because
It's a self-contained momentum/transition detector; can also feed `c` into **3**.

## Notes
- Best paired with **5 - Quarantine** so a detected turn first blocks the stale
  side rather than instantly flipping.
