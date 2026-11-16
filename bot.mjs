// Options Desk – single-file paper trading bot (GitHub Actions)
// PAPER TRADING ONLY. Not financial advice.
//
// Required Secrets: ALPACA_KEY, ALPACA_SECRET, NTFY_TOPIC
// Optional Secret:  FINNHUB_KEY  (free at finnhub.io – enables earnings filter)
// Variable:         AUTO=on      (set this to allow the bot to place/close paper trades)

const E = process.env;
const D = "https://data.alpaca.markets/";
const T = "https://paper-api.alpaca.markets/";
const H = {
  "APCA-API-KEY-ID": E.ALPACA_KEY,
  "APCA-API-SECRET-KEY": E.ALPACA_SECRET,
  "content-type": "application/json"
};

// ============ SETTINGS (change these if you want) ============
const RISK_PCT     = 0.02;   // max risk per new trade (2% of equity)
const MAX_POS      = 3;      // maximum open option positions
const DAILY_KILL   = -0.03;  // close everything if day P/L hits this
const MAX_SPREAD   = 0.08;   // max (ask-bid)/mid allowed
const MIN_DTE      = 5;      // force-close under this many days
const TARGET_DTE_LO = 21;
const TARGET_DTE_HI = 45;
const STOP_LOSS    = -0.40;  // -40%
const TAKE_PROFIT  =  0.60;  // +60%
// =============================================================

const UNI = "SPY QQQ IWM DIA XLF XLK XLE XLV XLY XLI XLP XLU SMH GLD TLT AAPL MSFT NVDA AMZN GOOGL META TSLA AMD NFLX AVGO CRM ORCL ADBE INTC QCOM MU COST WMT HD LOW NKE MCD SBUX DIS BA CAT DE GE JPM BAC WFC GS MS C V MA PYPL UNH LLY JNJ PFE MRK ABBV XOM CVX COP KO PEP PG T VZ CSCO IBM".split(" ");

const api = async (u, m = "GET", b) => {
  const r = await fetch(u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String(j.message || r.status));
  return j;
};

const sma = (a, n, e) => {
  let s = 0;
  for (let i = e - n; i < e; i++) s += a[i];
  return s / n;
};
const rsi = (a, e, n = 14) => {
  let g = 0, l = 0;
  for (let i = e - n; i < e; i++) {
    const d = a[i] - a[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  return l ? 100 - 100 / (1 + g / l) : 100;
};
const score = (a, e, F = 10, S = 30) => {
  const f = sma(a, F, e), s = sma(a, S, e), r = rsi(a, e), m = a[e - 1] / a[e - 11] - 1;
  let sc = (f > s ? 1 : -1) + (r > 55 ? 1 : r < 45 ? -1 : 0) + (m > 0.004 ? 1 : m < -0.004 ? -1 : 0);
  if (r > 78) sc--;
  if (r < 22) sc++;
  return { sc, r, m, f, s };
};
const side = sc => (sc >= 2 ? 1 : sc <= -2 ? -1 : 0);

const days = e => Math.round((Date.parse(e) - Date.now()) / 864e5);
const dt = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const money = x => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(0);
const pct = x => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";

const occ = s => {
  const m = s.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  return m && {
    root: m[1],
    exp: "20" + m[2].slice(0, 2) + "-" + m[2].slice(2, 4) + "-" + m[2].slice(4),
    type: m[3],
    strike: +m[4] / 1e3
  };
};

const out = [];
const say = l => out.push(l);
const push = async (t, b, p = 3) => {
  if (!E.NTFY_TOPIC) {
    console.log(t + "\n" + b);
    return;
  }
  await fetch("https://ntfy.sh/" + encodeURIComponent(E.NTFY_TOPIC), {
    method: "POST",
    headers: { Title: t, Priority: String(p) },
    body: b
  });
};

// Optional earnings blackout using free Finnhub key
async function nearEarnings(symbol) {
  if (!E.FINNHUB_KEY) return false;
  try {
    const from = dt(-1), to = dt(7);
    const j = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${symbol}&token=${E.FINNHUB_KEY}`
    ).then(r => r.json());
    const list = j.earningsCalendar || [];
    return list.some(e => e.symbol === symbol && days(e.date) >= 0 && days(e.date) <= 5);
  } catch {
    return false;
  }
}

// Pick best liquid contract near target DTE
async function contract(sym, px, wantCall) {
  const type = wantCall ? "call" : "put";
  const j = await api(
    `${D}v1beta1/options/snapshots/${sym}?feed=indicative&type=${type}` +
      `&limit=500&expiration_date_gte=${dt(TARGET_DTE_LO)}&expiration_date_lte=${dt(TARGET_DTE_HI)}` +
      `&strike_price_gte=${(px * 0.96).toFixed(2)}&strike_price_lte=${(px * 1.04).toFixed(2)}`
  );

  const rows = Object.entries(j.snapshots || {})
    .map(([k, v]) => {
      const m = occ(k);
      if (!m) return null;
      const bid = v.latestQuote?.bp || 0;
      const ask = v.latestQuote?.ap || 0;
      const mid = (bid + ask) / 2;
      const spread = mid > 0 ? (ask - bid) / mid : 99;
      return {
        sym: k,
        ...m,
        bid,
        ask,
        mid,
        spread,
        iv: v.impliedVolatility || 0,
        delta: v.greeks?.delta,
        gamma: v.greeks?.gamma,
        theta: v.greeks?.theta,
        vega: v.greeks?.vega
      };
    })
    .filter(r => r && r.ask > 0.05 && r.spread <= MAX_SPREAD && r.iv > 0);

  if (!rows.length) return null;

  // Prefer closest to 30 DTE, then closest strike
  rows.sort((a, b) => {
    const da = Math.abs(days(a.exp) - 30);
    const db = Math.abs(days(b.exp) - 30);
    if (da !== db) return da - db;
    return Math.abs(a.strike - px) - Math.abs(b.strike - px);
  });
  return rows[0];
}

async function main() {
  if (!E.ALPACA_KEY || !E.ALPACA_SECRET) {
    console.error("Missing ALPACA_KEY or ALPACA_SECRET");
    process.exit(1);
  }

  const open = (await api(T + "v2/clock")).is_open;
  const force = E.FORCE === "1";
  const auto = E.AUTO === "on";

  if (!open && !force) {
    console.log("Market closed. Exiting.");
    process.exit(0);
  }

  const acct = await api(T + "v2/account");
  const equity = +acct.equity;
  const lastEquity = +acct.last_equity || equity;
  const dayPnl = equity / lastEquity - 1;
  const riskBudget = equity * RISK_PCT;

  say(`Equity ${money(equity)} · Day ${pct(dayPnl)} · Risk budget ${money(riskBudget)} (${(RISK_PCT * 100).toFixed(0)}%)`);
  say(`AUTO=${auto ? "on" : "off"} · Market ${open ? "OPEN" : "closed"}`);

  // -------- Daily kill switch --------
  if (dayPnl <= DAILY_KILL) {
    say(`KILL SWITCH triggered (day P/L ${pct(dayPnl)}). Closing all option positions.`);
    const positions = await api(T + "v2/positions");
    for (const p of positions.filter(x => x.asset_class === "us_option")) {
      try {
        if (auto && open) {
          await api(T + "v2/positions/" + p.symbol, "DELETE");
          say(`Closed ${p.symbol} (kill switch)`);
        } else {
          say(`Would close ${p.symbol} (kill switch) – AUTO off or market closed`);
        }
      } catch (e) {
        say(`Failed to close ${p.symbol}: ${e.message}`);
      }
    }
    await push("Options Desk – KILL SWITCH", out.join("\n") + "\n\nPaper only.", 5);
    console.log("done (kill switch)");
    return;
  }

  // -------- Load daily bars & score --------
  const bars = (
    await api(
      `${D}v2/stocks/bars?symbols=${UNI.join(",")}&timeframe=1Day&feed=iex&adjustment=split&limit=10000&start=${new Date(Date.now() - 120 * 864e5).toISOString()}`
    )
  ).bars || {};

  const sig = {};
  for (const s of UNI) {
    const c = (bars[s] || []).map(b => b.c);
    if (c.length >= 40) sig[s] = { ...score(c, c.length), p: c[c.length - 1] };
  }

  // -------- Manage existing positions --------
  const pos = (await api(T + "v2/positions")).filter(p => p.asset_class === "us_option");
  const sold = new Set();
  const heldRoots = new Set();

  for (const p of pos) {
    const m = occ(p.symbol);
    if (!m) continue;
    heldRoots.add(m.root);
    const pl = +p.unrealized_plpc;
    const x = sig[m.root];
    const sd = x ? side(x.sc) : 0;
    const dte = days(m.exp);

    let why = "";
    if (pl <= STOP_LOSS) why = `stop loss (${pct(pl)})`;
    else if (pl >= TAKE_PROFIT) why = `take profit (${pct(pl)})`;
    else if (dte < MIN_DTE) why = `under ${MIN_DTE} DTE`;
    else if ((m.type === "C" && sd < 0) || (m.type === "P" && sd > 0)) why = "signal flipped";

    const nm = `${m.root} ${m.type === "C" ? "call" : "put"} ${m.strike} ${m.exp.slice(5)}`;
    const pnlStr = `P/L ${money(+p.unrealized_pl)} (${pct(pl)})`;

    if (why) {
      if (auto && open) {
        try {
          await api(T + "v2/positions/" + p.symbol, "DELETE");
          sold.add(p.symbol);
          say(`SOLD (paper) ${nm}: ${why}. ${pnlStr}`);
        } catch (e) {
          say(`SELL ${nm}: ${why}. ${pnlStr}. Auto-sell failed (${e.message})`);
        }
      } else {
        say(`SELL ${nm}: ${why}. ${pnlStr}`);
      }
    } else {
      say(`HOLD ${nm}: ${pnlStr} · ${dte}d left`);
    }
  }

  // -------- Rank new ideas --------
  const ranked = Object.entries(sig)
    .filter(([, x]) => Math.abs(x.sc) >= 2)
    .sort((a, b) => Math.abs(b[1].sc) - Math.abs(a[1].sc) || Math.abs(b[1].m) - Math.abs(a[1].m))
    .slice(0, 8);

  const ordersToday = open && auto
    ? await api(`${T}v2/orders?status=all&limit=50&after=${ymd}T00:00:00Z`)
    : [];
  let alreadyBoughtToday = ordersToday.some(o => String(o.client_order_id || "").startsWith("bot-" + ymd));

  const openCount = pos.filter(p => !sold.has(p.symbol)).length;
  let shown = 0;

  for (const [s, x] of ranked) {
    if (shown >= 3) break;
    if (heldRoots.has(s)) continue;

    if (await nearEarnings(s)) {
      say(`SKIP ${s}: earnings within ~5 days`);
      continue;
    }

    let c;
    try {
      c = await contract(s, x.p, x.sc > 0);
    } catch {
      continue;
    }
    if (!c) continue;
    shown++;

    const riskPer = c.ask * 100;
    const qty = Math.floor(riskBudget / riskPer);
    const holdDays = Math.max(3, Math.min(14, days(c.exp) - MIN_DTE));
    const strength = Math.round((Math.abs(x.sc) / 3) * 100);
    const nm = `${s} ${x.sc > 0 ? "call" : "put"} ${c.strike} ${c.exp.slice(5)}`;
    const greeks = c.delta != null
      ? `Δ ${c.delta.toFixed(2)}  Θ ${c.theta != null ? c.theta.toFixed(2) : "–"}  IV ${(c.iv * 100).toFixed(0)}%`
      : `IV ${(c.iv * 100).toFixed(0)}%`;

    let line = `BUY ${nm} @ ~$${c.ask.toFixed(2)} · max loss ${money(riskPer)}/contract · ${greeks} · strength ${strength}% · hold ~${holdDays}d · targets +60% / -40%`;

    if (qty < 1) {
      line += " · too big for risk budget";
    } else if (auto && open && !alreadyBoughtToday && openCount < MAX_POS) {
      try {
        await api(T + "v2/orders", "POST", {
          symbol: c.sym,
          qty: String(qty),
          side: "buy",
          type: "limit",
          limit_price: c.ask.toFixed(2),
          time_in_force: "day",
          client_order_id: `bot-${ymd}-${s}`
        });
        alreadyBoughtToday = true;
        line = "BOUGHT (paper) " + line.slice(4);
      } catch (e) {
        line += ` · auto-buy failed (${e.message})`;
      }
    }
    say(line);
  }

  if (shown === 0 && ranked.length === 0) say("No strong signals right now.");

  // -------- Current open positions summary --------
  const stillOpen = (await api(T + "v2/positions")).filter(p => p.asset_class === "us_option");
  if (stillOpen.length) {
    say("--- Open positions ---");
    for (const p of stillOpen) {
      const m = occ(p.symbol) || {};
      say(`${m.root || p.symbol} ${m.type === "C" ? "C" : "P"} ${m.strike} ×${p.qty} · ${money(+p.unrealized_pl)} (${pct(+p.unrealized_plpc)})`);
    }
  } else {
    say("No open option positions.");
  }

  if (force && !open) say("(Market closed – no orders were placed)");

  if (out.length) {
    await push(
      `Options Desk${open ? "" : " (test)"}`,
      out.join("\n") + "\n\nPaper trading only. Not financial advice.",
      4
    );
  }
  console.log("done,", out.length, "lines");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
