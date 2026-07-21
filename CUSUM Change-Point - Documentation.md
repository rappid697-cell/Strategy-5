# Polymarket BTC 15m Bot — Documentation

A trading bot and web dashboard for Polymarket's **"Bitcoin Up or Down" 15-minute** markets.

Every 15 minutes Polymarket opens a new binary market asking: *will BTC be higher at the end of this
15-minute window than it was at the window's open?* You buy **UP** or **DOWN** shares priced between
$0.00 and $1.00. The winning side pays **$1.00** per share; the losing side pays **$0**.

This bot watches the market, decides which side (if any) is mispriced, places the trade, manages the
position, and settles it — all automatically, in either **paper** (simulated) or **live** (real money) mode.

This build runs on **http://localhost:8204** and its dashboard / browser-tab title is **"BTC 15m · CUSUM"**.

---

## Strategy: CUSUM Change-Point

Unlike the base latency bot — which takes a **standing EV view every tick** (see
[section 1](#1-what-the-strategy-actually-does)) — this variant is **event-triggered**. It does nothing
until an accumulated change-point score crosses a threshold, then fires **once**. It trades the *moment
the market turns*, not a standing view.

### How it works

Each tick the bot turns the model's fair probability into a directional-evidence score:

```
Z = fair_up − 0.5          # positive = evidence for UP, negative = evidence for DOWN
```

and feeds it into a **two-sided CUSUM** (cumulative-sum change detector):

```
S⁺ = max(0,  S⁺ + Z − k)     # accumulates UPWARD evidence
S⁻ = min(0,  S⁻ + Z + k)     # accumulates DOWNWARD evidence
```

- `k` is the **slack** (drift allowance). It bleeds a little off each accumulator every tick, so pure
  noise keeps them pinned near zero and only a genuine, persistent shift builds them up.

An **entry fires only on a change-point** — the instant an accumulator crosses the threshold `H`:

```
S⁺ ≥  H   →  change-point UP    →  enter UP
S⁻ ≤ −H   →  change-point DOWN  →  enter DOWN
```

- `H` is the **decision threshold**: how much accumulated evidence is required before a turn is real.
- The crossing side must **also have non-negative edge** (`EV = fair − ask ≥ 0`). A turn the book has
  already repriced is not tradeable, so it is skipped (reason `changepoint_<side>_ev_..._below_...`).
- After a side fires, **only the crossed accumulator resets to 0** — the other keeps its value.
- **Both accumulators reset to 0 at every new 15-minute contract boundary**, so evidence never carries
  across windows.

It does **not** take standing-view entries: if no accumulator crosses this tick, there is **no trade**,
even when a plain EV edge exists. That is exactly what makes this the "trade the turn" bot.

### On the dashboard

The **Current Prediction** area adds a **CUSUM** readout showing the live **S⁺** and **S⁻** accumulators
and the **last change-point** that fired (its side, time, and the fair probability at the moment it
fired). Between change-points the decision reads **NO TRADE** with a reason such as
`no_change_point(S+=0.31,S-=-0.12)`.

### Config (`cusum`)

The `cusum` block in `config.json` controls the detector:

```json
"cusum": {
  "k": 0.05,
  "h": 0.5
}
```

| Field | Default | Meaning |
|---|---|---|
| `k` | `0.05` | **Slack** — drift allowance bled off each accumulator per tick. Higher `k` = more evidence needed to overcome the noise floor (fewer, cleaner change-points). |
| `h` | `0.5` | **Decision threshold `H`** — how far an accumulator must climb before a change-point fires. Higher `h` = later, higher-conviction entries; lower `h` = earlier, more frequent ones. |

---

## Table of contents

1. [What the strategy actually does](#1-what-the-strategy-actually-does)
2. [Paper mode vs Live mode](#2-paper-mode-vs-live-mode)
3. [The Dashboard](#3-the-dashboard)
4. [Starting and stopping the bot](#4-starting-and-stopping-the-bot)
5. [The Settings page](#5-the-settings-page)
6. [Position management: Flip, Take-Profit / Stop-Loss](#6-position-management)
7. [How a trade is settled (win or loss)](#7-how-a-trade-is-settled)
8. [Auto-Withdrawal (Capital Extractor)](#8-auto-withdrawal-capital-extractor)
9. [Reading the Trade History](#9-reading-the-trade-history)
10. [Logs and data files](#10-logs-and-data-files)
11. [Typical workflows](#11-typical-workflows)
12. [Safety and limitations](#12-safety-and-limitations)

---

## 1. What the strategy actually does

### The core idea: latency

A historical study found that the "obvious" indicator model had **no predictive edge** over a trivial
baseline — *"is BTC already above the window's open right now?"*. Whoever is ahead at any checkpoint
usually wins, and the market prices that in.

The only edge left is **latency**: acting on a Binance price move *before* Polymarket's thinner order
book has repriced it.

### The pipeline (runs every second)

```
Binance spot ──► fair probability ──► compare to Polymarket price ──► decide ──► size ──► execute
(fast feed)      (closed-form GBM)     (edge = fair − ask price)      (EV gate)   (% of    (Fill-Or-Kill
                                                                                  balance)  order)
```

**Step 1 — Fair probability.**
Using the current Binance spot price, the window's open price, and the realized volatility of recent
5-minute candles, the bot computes a closed-form probability that BTC will close **above** the open.
Intuitively it answers: *"given the volatility still to come, how likely is it that price stays on the
side it's currently on?"*

**Step 2 — The edge.**
Polymarket's UP/DOWN prices are normalized into an implied probability. The bot compares:

```
Edge (EV) = fair probability − the ask price you'd pay
```

A positive edge means the book hasn't yet repriced a move the fast feed already sees.

**Step 3 — The entry gate.**
The side with the higher EV is chosen. The bot enters **only if both** pass:

| Gate | Default | Meaning |
|---|---|---|
| `ev_threshold` | 0.04 | The EV must be at least this (a 4¢ edge per $1 share). |
| `min_prob` | 0.55 | Never bet a near-coinflip, even if the EV looks positive. |

It also skips the trade if the order book's ask side is too thin to absorb the stake
(`min_book_liquidity_usd`).

**Step 4 — Sizing.**
The stake is either a **percent of your balance** or a **flat dollar amount** (your choice).

**Step 5 — Execution.**
A **Fill-Or-Kill** order with a slippage cap. If the book moves away, the order is killed rather than
filled at a bad price. **Only one position is held at a time.**

---

## 2. Paper mode vs Live mode

Set this at the top of the Settings page.

### Paper mode (default, safe)
- No real money. No wallet needed.
- The bot simulates a balance (you set the starting amount).
- Everything else — signals, entries, flips, TP/SL, settlement — behaves identically.
- **This is where you should validate the strategy before ever going live.**

### Live mode (real money)
- Places real **Fill-Or-Kill** orders on Polymarket CLOB V2.
- Your balance display becomes your **real on-chain pUSD balance** (refreshed every ~10 seconds).
- Requires credentials (see [Settings → Credentials](#credentials--live-trading)).

**How live trading works under the hood:** your private key or seed phrase only **signs** orders — it
holds no funds and pays no gas. Your money lives in a **Polymarket deposit wallet**, and a **relayer
API key** sponsors the one-time on-chain setup (wallet deployment + token approvals) so you never pay
gas. All of this is automatic before your first live order.

---

## 3. The Dashboard

The main page (`/`) refreshes every second.

### Header bar

| Element | What it shows |
|---|---|
| **Binance WS / Poly WS** dots | Green = the price feeds are connected. Red = a feed is down. |
| **Paper / Live Balance** | Your current balance, live. Yellow in paper mode, green in live mode. |
| **▶ Start / ■ Stop** | Turns trading on or off (see below). |
| **⤓ ARMED** badge | Only appears when auto-withdrawal is enabled; shows its current state. |
| **paper / live** pill | Which mode you're in. |
| **Updated** | Time of the last refresh. |

### Market summary
- **BTC Binance Spot** — the fast price feed that drives the model.
- **Polymarket Chainlink** — the settlement price feed. Below it:
  - **Close src** — which feed is currently providing it (green = `Polymarket WS`, yellow = a fallback).
  - **Open (strike)** — the price the current window opened at, and where that number came from.
- **Time Remaining** — countdown to the end of the current 15-minute window.

### Current Prediction
- **PROB UP / PROB DOWN** — the model's fair probability for each side.
- The big centre text is the decision: **BUY UP ↑**, **BUY DOWN ↓**, or **NO TRADE**, with the reason
  underneath (e.g. `ev_0.018_below_0.040` means the edge wasn't big enough).

### Panels
- **Technical Indicators** — the model's fair probability for the 15m close.
- **Polymarket Odds** — the live UP/DOWN prices and the model's edge.

### Tabs
- **Active Trades** — your open position: market, side, entry price, shares, **Opened by** (EV or FLIP),
  **Unrealized P/L** (marked against the current bid), and status.
- **Closed Trades** — full trade history (see [section 9](#9-reading-the-trade-history)).
- **Console Log** — a live event feed: entries, flips, TP/SL hits, settlements, withdrawals, errors.

### Equity vs Cash
The Trades tab shows **Equity = cash + the value of your open position**, so the headline number
doesn't drop just because you entered a trade. The breakdown (`Cash $X + Open $Y`) is shown beneath it.

---

## 4. Starting and stopping the bot

**The bot boots in a STOPPED state.** Price feeds stream and the dashboard updates, but **no trades are
placed** until you press **▶ Start**.

- **▶ Start** — the bot may now enter trades and flip positions.
- **■ Stop** — new entries and flips halt **immediately**. Any position already open keeps running and
  will still settle normally at expiry (it can't get stuck).

Use Stop whenever you want to pause trading without killing the app.

---

## 5. The Settings page

Reachable via the gear icon. **Save Changes** applies everything immediately — no restart needed.

### Trading Mode
- **Mode** — `paper` or `live`.
- **Paper Balance** — the starting simulated balance (paper mode only).

### Market
- **Series** — which 15-minute market to trade (BTC by default; ETH and others are available).
- **Symbol** — the Binance symbol used for the fast price feed (e.g. `BTCUSDT`).

### Risk per trade
- **Risk Type**
  - `percent` — stake this **% of your current balance** on each trade.
  - `fixed` — stake this **flat dollar amount** each trade.
- **Risk Value** — the number for the above (e.g. `10` = 10% of balance, or $10 if fixed).

> With `percent` sizing, a losing streak compounds. Keep this modest.

### Strategy Controls (the entry gates)
- **EV Threshold** (default `0.04`) — the minimum edge (fair probability − share price) required to
  enter. Raise it to trade less often but only on bigger edges; lower it to trade more often.
- **Min Probability** (default `0.55`) — don't bet near-coinflips even if the EV looks positive.

### Close & Flip on Strong Opposite Signal
See [section 6](#close--flip).

### Take-Profit / Stop-Loss
See [section 6](#take-profit--stop-loss).

### Credentials & Live Trading
Only needed for **live** mode.

| Field | What it's for |
|---|---|
| **Private Key or Seed Phrase** | Your EOA wallet. Paste a hex private key **or** a 12/24-word seed phrase — the wallet is derived from it. Only the derived key is stored; the seed phrase is never written to disk. This key **signs orders only** — it holds no funds and pays no gas. |
| **Relayer API Key** | Sponsors gas for the one-time on-chain setup (deposit-wallet deployment + token approvals), so you never pay gas. Get it from polymarket.com → Settings → Relayer API keys. |
| **Alchemy RPC API Key** | *Optional.* A private Polygon RPC for on-chain reads. Leave blank to use public RPCs. |

**Test Connection** — saves your credentials, then derives your wallet and reports:
- your **EOA** address,
- which **trading wallet** was detected (deposit / proxy / safe) and its signature type,
- whether the **relayer key** is set,
- which wallet actually holds **pUSD** (your tradeable funds).

If it says *"no pUSD found yet"*, deposit funds on polymarket.com first.

### Auto-Withdrawal
See [section 8](#8-auto-withdrawal-capital-extractor).

---

## 6. Position management

The bot holds **one position at a time** and, by default, holds it to expiry. Two optional features can
exit or reverse a position early.

### Close & Flip

**What it does:** if you're holding a position and the model swings hard to the **opposite** side, the
bot sells your current side and buys the other one.

**Settings:**
- **Enabled** — on/off.
- **Min Conviction** — the opposite side's fair probability must be at least this (e.g. `0.65`).
- **Min Minutes Left** — at least this much time must remain in the 15-minute window (e.g. `4`). Late in
  a window there isn't enough runway left for a reversal to pay off, so flips are blocked.

**Important rules:**
- **One flip per market.** After a flip, that position is **held to settlement** — the bot will not flip
  again in the same 15-minute window, no matter what the model does. This prevents costly churn.
- A flip is driven by **fair probability only**, not by EV.
- A flip **realizes a loss** on the side you exit (you sell into the bid, below your entry). It only
  makes sense when the model has genuinely turned against your position.

### Take-Profit / Stop-Loss

**What it does:** closes the open position early when its value moves a set percentage **of the amount
you risked**.

**Settings:**
- **Enabled** — on/off.
- **Take Profit (% of stake)** — sell when the position is up this much (e.g. `30` = +30%).
- **Stop Loss (% of stake)** — sell when the position is down this much (e.g. `30` = −30%).

**How it's measured:** the position is marked against the **current bid** (what you'd actually get if
you sold right now):

```
P/L %  =  (shares × current bid − stake) ÷ stake × 100
```

**Example:** you stake $100 at 50¢ → 200 shares.
- Bid rises to 65¢ → value $130 → **+30% → Take-Profit fires**, you bank ~$30.
- Bid falls to 35¢ → value $70 → **−30% → Stop-Loss fires**, you cut the loss at ~−$30.

**After TP or SL fires, the bot will NOT re-enter that market.** It waits for the **next 15-minute
market** to start. This stops it from immediately re-entering the same losing setup.

> If both Flip and TP/SL are enabled, **TP/SL takes precedence** — it runs first, and once it fires the
> market is locked so no flip can reopen a position there.

---

## 7. How a trade is settled

Polymarket resolves these markets on **Chainlink** — the price at the window's close versus the price
at the window's open. The bot mirrors this exactly.

**Marking the OPEN.** At the instant a 15-minute window begins, the bot snapshots the **Polymarket
Chainlink WS price** and stores it as that window's open (the "strike"). You can see it on the
dashboard as **Open (strike)**.

> **If the bot did not capture a window's open** (for example, it was started mid-window), it will **not
> trade that window at all**. It waits for the next window, where it can mark the real open. This is
> deliberate: without a true open, a trade can't be scored correctly.

**Marking the CLOSE.** The moment the window expires, the Chainlink price is **frozen** as the close. It
is not allowed to drift afterwards.

**Deciding win or loss**, in priority order:

1. **Polymarket's own settlement** — once the market officially resolves (the winning outcome trades at
   ~$1), that is authoritative and always wins.
2. **Close vs Open** — before Polymarket resolves, the bot compares the frozen Chainlink close against
   the marked Chainlink open. `close > open` → UP wins; otherwise DOWN wins. Both values come from the
   same feed, so no price offset can flip the result.
3. **Void** — if a trade still can't be resolved 5 minutes past expiry, it is voided and the stake is
   refunded (paper mode).

Every settlement is logged with the full picture, e.g.:

```
WIN [close_vs_open] UP: open 67380.00 -> close 67421.50 (UP by 41.50) -> P/L $+104.00
```

**Payouts:**
- **Win at expiry:** each share pays $1.00 → `P/L = shares − stake`.
- **Loss at expiry:** shares are worth $0 → `P/L = −stake`.
- **Early exit (Flip / TP / SL):** you sold your shares → `P/L = shares × sell price − stake`.

---

## 8. Auto-Withdrawal (Capital Extractor)

Automatically pulls profit out of the trading wallet once your **equity** grows past a threshold, then
resumes trading. **Live mode only.**

### Settings
| Field | Meaning |
|---|---|
| **Enable auto-withdrawal** | Master on/off. |
| **Trigger Balance** | Withdraw once your **equity** reaches this (e.g. `2000`). |
| **Withdraw Amount** | How much pUSD to withdraw each time (e.g. `1000` = half of 2000). |
| **Withdraw To** | Destination address. **Leave blank to send to your own wallet** (the address derived from your key/seed). |
| **Auto-resume after withdrawal** | **On:** trading resumes at the next 15m market. **Off:** the bot is **stopped completely** after withdrawing. |
| **Resume After** | `submitted` (immediately, the default) or `confirmed`. |

### It triggers on EQUITY, not just cash

**Equity = cash balance + the current value of any open position.** This means a **running trade still
counts** toward the trigger — you don't have to wait for it to settle for the threshold to be reached.

### It closes an open trade immediately

If a trade is **open** when equity hits the trigger, the bot **closes it right away** (sells at the
current bid) so the funds settle into cash and the withdrawal can proceed. It does not wait for expiry.

### The state machine

```
ARMED
  │  EQUITY (cash + open position value) reaches the trigger
  ▼
WAITING_FLAT        ← new entries PAUSED; any OPEN TRADE IS CLOSED IMMEDIATELY (sold at the bid)
  │  account is flat (position sold, funds settled)
  ▼
WITHDRAWING         ← sends the withdrawal (gasless, via the relayer)
  │  transfer submitted
  ▼
WITHDRAW_SUBMITTED
  │
  ▼
ARMED
  ├─ auto-resume ON  → trading resumes at the NEXT 15m market (this one stays locked)
  └─ auto-resume OFF → the bot is STOPPED (press ▶ Start to trade again)
```

The current state is shown on the dashboard as the **⤓** badge (green when `ARMED`, amber while a
withdrawal is in progress). A trade closed this way appears in the history with exit reason
`withdraw_close`.

> ⚠️ Withdrawals move **real funds** and cannot be undone. Double-check the destination address, and do
> one small test withdrawal before relying on the automatic trigger.
>
> ⚠️ Because it force-closes an open position, a withdrawal **realizes whatever P/L that position
> currently has** (selling into the bid). Set the trigger at a level where you're happy to exit.

### Telegram alerts (on withdrawal)

Every time a withdrawal completes, the bot broadcasts a message with the **time** and **amount** to
**everyone who has subscribed**. Subscription is **automatic** — there are no chat IDs to copy. Configure
it in **Settings → Telegram Alerts**:

| Field | Meaning |
|---|---|
| **Send Telegram alerts on withdrawal** | Master on/off. |
| **Bot Token** | Create a bot with **@BotFather** on Telegram and paste its token. |
| **Subscribers** panel | Live list of everyone currently subscribed. **Refresh** re-fetches it; the **✕** next to a name removes that subscriber. |
| **Send Test** button | Saves your settings and broadcasts a test message to every subscriber so you can confirm it works. |

**How people subscribe (no chat IDs needed):**

While the bot is running it quietly watches for messages sent to it. Anyone who wants alerts just:

1. **A single user:** opens your bot on Telegram and sends **`/start`** (or any message). They're added to the
   Subscribers list automatically and will get every withdrawal alert.
2. **A group:** add the bot to the group and send any message — the group is subscribed (its id is a negative number).
3. **A channel:** add the bot as an **admin** and post once — the channel is subscribed.

To stop receiving alerts, a user sends **`/stop`** to the bot (or you remove them with **✕** in the Subscribers panel).

> ⚠️ Telegram does not allow a bot to start a conversation, so each person must message the bot **first** — that
> single message is what subscribes them. The bot must be **running** for it to pick up new subscribers. Subscribers
> are saved to `telegram_subscribers.json` and persist across restarts.

### Reaching multiple people

- **Many individual users** → each person sends `/start` to the bot once; all of them receive every alert. Unlimited recipients.
- **One group or channel** everyone joins → add the bot there and post once; the bot broadcasts to it and everyone in it sees the alert.

The alert looks like:

```
💸 Withdrawal completed
Amount: $1000.00
Time: 2026-07-13 04:51:44
To: 0x....
Tx: 0x....
```

Alerts are best-effort — if Telegram is unreachable, trading is never affected.

---

## 9. Reading the Trade History

Each closed trade shows:

| Column | Meaning |
|---|---|
| **Market** | Which 15-minute market. |
| **Side** | UP or DOWN. |
| **Entry** | The price you paid per share (in cents). |
| **Opened by** | **`EV`** = opened by the normal signal. **`FLIP`** = opened by a flip reversal. |
| **Exit** | How the trade ended (see below). |
| **Open→Close** | The market's actual move, e.g. `67,380→67,421 ↑`. Green = price rose, red = fell. |
| **P/L** | Realized profit or loss in dollars. |
| **Settled** | When it closed. |

### Exit values

| Value | Meaning |
|---|---|
| **`SETTLED`** | Held to expiry and resolved normally. |
| **`TP`** | Closed early by **Take-Profit**. |
| **`SL`** | Closed early by **Stop-Loss**. |
| **`FLIP ✓won`** | Flipped out of this side — and this side **went on to win** the market. (You exited a winner.) |
| **`FLIP ✗lost`** | Flipped out of this side — and this side **lost** the market. (Flipping saved you.) |
| **`VOID`** | Couldn't be resolved; stake refunded, P/L $0. |

Reading a row end-to-end tells you the whole story. For example:

> `DOWN · 45¢ · EV · FLIP ✓won · 63,986→63,935 ↓ · −$51.45`

means: the signal correctly entered DOWN at 45¢, the market **did** go down (so DOWN won), **but** the
bot flipped out of it early and booked a $51 loss on a trade that would have won.

---

## 10. Logs and data files

| File | Contents |
|---|---|
| `logs/signals.csv` | **One row per tick.** The full decision record — model probabilities, market prices, the edge, the chosen side's probability/price/EV, the decision, the exact reason it did or didn't trade, and the execution result. This is the file to analyse if you want to mine for better filters. |
| `state_data.json` | Persisted balance, open positions, and trade history. Survives restarts. |
| `config.json` | All your settings (also editable from the Settings page). |
| **Console Log** tab | A human-readable live event feed of the same activity. |

### Key `signals.csv` columns
- `model_up` / `model_down` — the model's fair probabilities.
- `mkt_up` / `mkt_down` — Polymarket's prices.
- `edge_up` / `edge_down` — the model's edge on each side.
- `chosen_side`, `chosen_prob`, `chosen_price`, `chosen_ev` — the side the engine picked and its inputs,
  logged **even when it didn't trade**.
- `reason` — precisely why (e.g. `ev_enter`, `prob_0.46_below_0.55`, `ev_0.011_below_0.040`).
- `exec_result` — what happened (`entered`, `slot_busy`, `thin_book`, `stopped`, `take_profit`,
  `stop_loss`, `tp_sl_locked`, `no_open_price`, `flipped_to_DOWN`, …).

> If you change the CSV columns, delete the old `logs/signals.csv` so a fresh file with the new header
> is written.

---

## 11. Typical workflows

### Trying the strategy safely
1. Set **Mode = paper** and a **Paper Balance**.
2. Choose your **Risk Type / Risk Value** (start small — e.g. 3–5% of balance).
3. Leave **Flip** and **TP/SL** off to see the raw strategy first.
4. Press **▶ Start** and let it run for at least a day or two.
5. Review the **Closed Trades** tab and `logs/signals.csv`. Look at win rate and net P/L.

### Testing a feature (A/B)
Run for a stretch with a feature **off**, then a stretch with it **on**, and compare the History tab.
Since features are toggles, this is easy — e.g. run TP/SL off for a day, then on for a day.

### Going live
1. **Validate in paper first.** Do not skip this.
2. Settings → **Credentials**: enter your key/seed and relayer key. Press **Test Connection** and confirm
   it finds your wallet.
3. Deposit funds on polymarket.com so your deposit wallet holds **pUSD**.
4. Set **Mode = live**. Keep **Risk Value** small to start.
5. Press **▶ Start**. Watch the Console Log for the first order.
6. Optionally enable **Auto-Withdrawal** to bank profit automatically.

### Pausing
Press **■ Stop**. Open positions still settle; no new trades are taken.

---

## 12. Safety and limitations

**This is not financial advice. Live mode trades real money at your own risk.**

- **The edge is unproven.** The strategy's premise is that Polymarket's book is slower than Binance. That
  may or may not hold at any given time. **Run in paper mode and confirm profitable trades actually
  appear before risking capital.**
- **Paper results overstate live results.** Paper fills happen at the quoted price with **no spread and
  no slippage**. In live trading you buy at the ask and sell at the bid. On a near-coinflip market, a
  1–2¢ spread can consume most of a thin edge. Measure the real spread before trusting paper P/L.
- **Percent sizing compounds losses.** A run of losses at 10% of balance each shrinks the account fast.
  Size conservatively.
- **The market can trend against the model.** These are short-horizon binaries; sustained directional
  moves can produce long losing streaks.
- **Withdrawals are irreversible.** Verify the destination address; test with a small amount.
- **Early exits cost money.** Flips and stop-losses sell into the bid, realizing a loss plus the spread.
  They protect you from worse outcomes but are not free.
