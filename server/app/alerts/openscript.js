// GENERATED from web/src/scripts/engine.ts by npm run build:engine — do not edit
"use strict";
var OpenScript = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/scripts/engine.ts
  var engine_exports = {};
  __export(engine_exports, {
    runScript: () => runScript,
    ta: () => ta
  });
  var nan = Number.NaN;
  var isNum = (v) => typeof v === "number" && Number.isFinite(v);
  function src(x, n) {
    return Array.isArray(x) ? x : new Array(n).fill(x);
  }
  var ta = {
    sma(s, len) {
      const out = new Array(s.length).fill(nan);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < s.length; i++) {
        if (isNum(s[i])) {
          sum += s[i];
          count++;
        }
        if (i >= len && isNum(s[i - len])) {
          sum -= s[i - len];
          count--;
        }
        if (i >= len - 1 && count === len) out[i] = sum / len;
      }
      return out;
    },
    ema(s, len) {
      const out = new Array(s.length).fill(nan);
      const a = 2 / (len + 1);
      let prev = nan;
      let seed = 0;
      let seen = 0;
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        if (!isNum(v)) continue;
        if (!isNum(prev)) {
          seed += v;
          seen++;
          if (seen === len) {
            prev = seed / len;
            out[i] = prev;
          }
        } else {
          prev = a * v + (1 - a) * prev;
          out[i] = prev;
        }
      }
      return out;
    },
    rma(s, len) {
      const out = new Array(s.length).fill(nan);
      let prev = nan;
      let seed = 0;
      let seen = 0;
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        if (!isNum(v)) continue;
        if (!isNum(prev)) {
          seed += v;
          seen++;
          if (seen === len) out[i] = prev = seed / len;
        } else {
          out[i] = prev = (prev * (len - 1) + v) / len;
        }
      }
      return out;
    },
    wma(s, len) {
      const out = new Array(s.length).fill(nan);
      const denom = len * (len + 1) / 2;
      for (let i = len - 1; i < s.length; i++) {
        let acc = 0;
        let ok = true;
        for (let k = 0; k < len; k++) {
          const v = s[i - k];
          if (!isNum(v)) {
            ok = false;
            break;
          }
          acc += v * (len - k);
        }
        if (ok) out[i] = acc / denom;
      }
      return out;
    },
    stdev(s, len) {
      const mean = ta.sma(s, len);
      return s.map((_, i) => {
        if (!isNum(mean[i])) return nan;
        let acc = 0;
        for (let k = 0; k < len; k++) acc += (s[i - k] - mean[i]) ** 2;
        return Math.sqrt(acc / len);
      });
    },
    highest(s, len) {
      return s.map((_, i) => i < len - 1 ? nan : Math.max(...s.slice(i - len + 1, i + 1)));
    },
    lowest(s, len) {
      return s.map((_, i) => i < len - 1 ? nan : Math.min(...s.slice(i - len + 1, i + 1)));
    },
    change(s, len = 1) {
      return s.map((v, i) => i < len ? nan : v - s[i - len]);
    },
    mom(s, len) {
      return ta.change(s, len);
    },
    roc(s, len) {
      return s.map((v, i) => i < len || !s[i - len] ? nan : (v - s[i - len]) / s[i - len] * 100);
    },
    sum(s, len) {
      return ta.sma(s, len).map((v) => v * len);
    },
    rsi(s, len = 14) {
      const up = s.map((v, i) => i === 0 ? nan : Math.max(v - s[i - 1], 0));
      const dn = s.map((v, i) => i === 0 ? nan : Math.max(s[i - 1] - v, 0));
      const ru = ta.rma(up, len);
      const rd = ta.rma(dn, len);
      return ru.map((u, i) => !isNum(u) || !isNum(rd[i]) ? nan : rd[i] === 0 ? 100 : 100 - 100 / (1 + u / rd[i]));
    },
    macd(s, fast = 12, slow = 26, signal = 9) {
      const f = ta.ema(s, fast);
      const sl = ta.ema(s, slow);
      const macd = f.map((v, i) => v - sl[i]);
      const sig = ta.ema(macd, signal);
      return { macd, signal: sig, hist: macd.map((v, i) => v - sig[i]) };
    },
    bb(s, len = 20, mult = 2) {
      const basis = ta.sma(s, len);
      const dev = ta.stdev(s, len);
      return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) };
    },
    tr(high, low, close) {
      return high.map(
        (h, i) => i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))
      );
    },
    atr(high, low, close, len = 14) {
      return ta.rma(ta.tr(high, low, close), len);
    },
    stoch(close, high, low, len = 14) {
      const hh = ta.highest(high, len);
      const ll = ta.lowest(low, len);
      return close.map((c, i) => hh[i] === ll[i] ? nan : (c - ll[i]) / (hh[i] - ll[i]) * 100);
    },
    cci(s, len = 20) {
      const ma = ta.sma(s, len);
      return s.map((v, i) => {
        if (!isNum(ma[i])) return nan;
        let md = 0;
        for (let k = 0; k < len; k++) md += Math.abs(s[i - k] - ma[i]);
        md /= len;
        return md === 0 ? 0 : (v - ma[i]) / (0.015 * md);
      });
    },
    vwap(high, low, close, volume) {
      let pv = 0;
      let vv = 0;
      return close.map((c, i) => {
        pv += (high[i] + low[i] + c) / 3 * volume[i];
        vv += volume[i];
        return vv ? pv / vv : nan;
      });
    },
    obv(close, volume) {
      let acc = 0;
      return close.map((c, i) => {
        if (i > 0) acc += c > close[i - 1] ? volume[i] : c < close[i - 1] ? -volume[i] : 0;
        return acc;
      });
    },
    crossover(a, b) {
      const n = Array.isArray(a) ? a.length : b.length;
      const x = src(a, n);
      const y = src(b, n);
      return x.map((v, i) => i > 0 && v > y[i] && x[i - 1] <= y[i - 1]);
    },
    crossunder(a, b) {
      const n = Array.isArray(a) ? a.length : b.length;
      const x = src(a, n);
      const y = src(b, n);
      return x.map((v, i) => i > 0 && v < y[i] && x[i - 1] >= y[i - 1]);
    },
    /** Per-bar helpers for strategy callbacks. */
    crossedUp(a, b, i) {
      const av = (j) => Array.isArray(a) ? a[j] : a;
      const bv = (j) => Array.isArray(b) ? b[j] : b;
      return i > 0 && av(i) > bv(i) && av(i - 1) <= bv(i - 1);
    },
    crossedDown(a, b, i) {
      const av = (j) => Array.isArray(a) ? a[j] : a;
      const bv = (j) => Array.isArray(b) ? b[j] : b;
      return i > 0 && av(i) < bv(i) && av(i - 1) >= bv(i - 1);
    }
  };
  function runStrategy(bars, onBar, ctl, opts) {
    const trades = [];
    const fills = [];
    const equity = [];
    const drawdown = [];
    let realized = 0;
    let commission = 0;
    let pos = null;
    let pending = [];
    let peak = opts.initialCapital;
    let maxDd = 0;
    let maxDdPct = 0;
    const fee = (price, qty) => price * qty * opts.pointValue * opts.commissionPct / 100;
    const closePos = (price, time, i, reason) => {
      if (!pos) return;
      const dir = pos.side === "long" ? 1 : -1;
      fills.push({ time, action: dir > 0 ? "sell" : "buy", id: pos.id, price, qty: pos.qty, kind: "exit", reason });
      const gross = (price - pos.entryPrice) * dir * pos.qty * opts.pointValue;
      const c = fee(price, pos.qty);
      commission += c;
      realized += gross - c;
      trades.push({
        id: pos.id,
        side: pos.side,
        qty: pos.qty,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        exitTime: time,
        exitPrice: price,
        pnl: gross - c - fee(pos.entryPrice, pos.qty),
        pnlPct: (price - pos.entryPrice) / pos.entryPrice * 100 * dir,
        exitReason: reason,
        bars: i - pos.entryIndex
      });
      pos = null;
    };
    const openPos = (o, price, time, i) => {
      const qty = o.qty ?? opts.qty;
      const c = fee(price, qty);
      commission += c;
      realized -= c;
      pos = { id: o.id, side: o.side, qty, entryPrice: price, entryTime: time, entryIndex: i, sl: o.sl, tp: o.tp };
      fills.push({ time, action: o.side === "long" ? "buy" : "sell", id: o.id, price, qty, kind: "entry", reason: o.reason });
    };
    const execute = (orders, price, time, i) => {
      for (const o of orders) {
        if (o.kind === "close") {
          if (pos && (o.id === "*" || o.id === pos.id)) closePos(price, time, i, o.reason);
        } else {
          if (pos && pos.side === o.side) continue;
          if (pos) closePos(price, time, i, `reverse to ${o.id}`);
          openPos(o, price, time, i);
        }
      }
    };
    ctl.bind({
      entry: (id, side, o = {}) => pending.push({ kind: "entry", id, side, qty: o.qty, sl: o.sl, tp: o.tp, reason: id }),
      close: (id = "*", reason = "close") => pending.push({ kind: "close", id, reason }),
      position: () => pos ? { side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice, id: pos.id } : null
    });
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!opts.fillOnClose && pending.length) {
        const orders = pending;
        pending = [];
        execute(orders, b.open, b.time, i);
      }
      if (pos) {
        const p = pos;
        const long = p.side === "long";
        if (p.sl != null && (long ? b.low <= p.sl : b.high >= p.sl)) {
          closePos(long ? Math.min(b.open, p.sl) : Math.max(b.open, p.sl), b.time, i, "stop loss");
        } else if (p.tp != null && (long ? b.high >= p.tp : b.low <= p.tp)) {
          closePos(long ? Math.max(b.open, p.tp) : Math.min(b.open, p.tp), b.time, i, "take profit");
        }
      }
      onBar(i);
      if (opts.fillOnClose && pending.length) {
        const orders = pending;
        pending = [];
        execute(orders, b.close, b.time, i);
      }
      const cur = pos;
      const open = cur ? (b.close - cur.entryPrice) * (cur.side === "long" ? 1 : -1) * cur.qty * opts.pointValue : 0;
      const eq = opts.initialCapital + realized + open;
      equity.push({ time: b.time, value: eq });
      peak = Math.max(peak, eq);
      const dd = peak - eq;
      drawdown.push({ time: b.time, value: -dd });
      if (dd > maxDd) maxDd = dd;
      if (peak > 0) maxDdPct = Math.max(maxDdPct, dd / peak * 100);
    }
    const last = bars[bars.length - 1];
    const openPnl = pos && last ? (last.close - pos.entryPrice) * (pos.side === "long" ? 1 : -1) * pos.qty * opts.pointValue : 0;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
    const rets = equity.map((e, i) => i === 0 ? 0 : equity[i - 1].value ? e.value / equity[i - 1].value - 1 : 0).slice(1);
    const mean = rets.reduce((a, r) => a + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
    const first = bars[0];
    return {
      trades,
      fills,
      equity,
      drawdown,
      metrics: {
        netProfit: realized,
        netProfitPct: realized / opts.initialCapital * 100,
        grossProfit,
        grossLoss,
        totalTrades: trades.length,
        winRate: trades.length ? wins.length / trades.length * 100 : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
        maxDrawdown: maxDd,
        maxDrawdownPct: maxDdPct,
        avgTrade: trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : 0,
        avgWin: wins.length ? grossProfit / wins.length : 0,
        avgLoss: losses.length ? -grossLoss / losses.length : 0,
        largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
        largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
        sharpe: sd > 0 ? mean / sd * Math.sqrt(252) : null,
        buyHoldPct: first && last ? (last.close / first.open - 1) * 100 : 0,
        commissionPaid: commission,
        openPnl
      }
    };
  }
  var StrategyControl = class {
    constructor() {
      __publicField(this, "api", null);
    }
    bind(api) {
      this.api = api;
    }
    get() {
      if (!this.api) throw new Error("strategy.entry/close can only be called inside strategy.onBar");
      return this.api;
    }
  };
  var PALETTE = ["#2962FF", "#FF6D00", "#AB47BC", "#26A69A", "#F23645", "#FDD835", "#7E57C2", "#00BCD4"];
  var BLOCKED = [
    "self",
    "globalThis",
    "window",
    "document",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "importScripts",
    "postMessage",
    "indexedDB",
    "caches",
    "localStorage",
    "sessionStorage",
    "navigator",
    "location",
    "setTimeout",
    "setInterval"
  ];
  function runScript(source, bars, inputValues = {}, opts = {}) {
    const n = bars.length;
    const col = (k) => bars.map((b) => b[k]);
    const open = col("open");
    const high = col("high");
    const low = col("low");
    const close = col("close");
    const volume = col("volume");
    const time = col("time");
    const hl2 = high.map((h, i) => (h + low[i]) / 2);
    const hlc3 = high.map((h, i) => (h + low[i] + close[i]) / 3);
    const ohlc4 = open.map((o, i) => (o + high[i] + low[i] + close[i]) / 4);
    const sources = { open, high, low, close, hl2, hlc3, ohlc4, volume };
    const meta = {
      name: /\/\/\s*@name\s+(.+)/.exec(source)?.[1]?.trim() ?? "Script",
      overlay: !/\/\/\s*@overlay\s+false/.test(source)
    };
    const inputs = [];
    const plots = [];
    const plotData = {};
    const hlines = [];
    const markers = [];
    const logs = [];
    const alerts = [];
    let onBar = null;
    const strategyOpts = {
      initialCapital: 1e5,
      qty: 1,
      commissionPct: 0,
      pointValue: opts.pointValue ?? 1,
      fillOnClose: false,
      ...opts.strategy
    };
    const ctl = new StrategyControl();
    const toPoints = (s, colors) => s.map((v, i) => {
      const value = typeof v === "boolean" ? v ? 1 : 0 : v;
      const p = { time: time[i], value: isNum(value) ? value : null };
      if (colors?.[i]) p.color = colors[i];
      return p;
    });
    const api = {
      open,
      high,
      low,
      close,
      volume,
      time,
      hl2,
      hlc3,
      ohlc4,
      bar_count: n,
      na: nan,
      nz: (v, d = 0) => isNum(v) ? v : d,
      ta,
      math: Math,
      indicator(o) {
        if (o.name) meta.name = o.name;
        if (o.overlay != null) meta.overlay = o.overlay;
      },
      input(title, defval, o = {}) {
        const id = title;
        let type = o.type ?? (typeof defval === "boolean" ? "bool" : typeof defval === "string" ? "string" : Number.isInteger(defval) ? "int" : "float");
        if (typeof defval === "string" && defval in sources && !o.options) type = "source";
        if (!inputs.some((x) => x.id === id)) inputs.push({ id, title, type, defval, options: o.options, min: o.min, max: o.max });
        const v = id in inputValues ? inputValues[id] : defval;
        return type === "source" ? sources[String(v)] ?? close : v;
      },
      plot(series, title, color, o = {}) {
        const id = `plot${plots.length}`;
        plots.push({
          id,
          title: title ?? id,
          color: color ?? PALETTE[plots.length % PALETTE.length],
          lineWidth: o.width ?? (o.style === "histogram" ? 1 : 2),
          style: o.style ?? "line"
        });
        plotData[id] = toPoints(series, o.colors);
      },
      hline(price, title = "", color = "#787B86") {
        hlines.push({ id: `hline${hlines.length}`, price, title, color });
      },
      plotshape(cond, o = {}) {
        cond.forEach((c, i) => {
          if (c)
            markers.push({
              time: time[i],
              position: o.location === "below" ? "belowBar" : "aboveBar",
              shape: o.shape ?? (o.location === "below" ? "arrowUp" : "arrowDown"),
              color: o.color ?? "#2962FF",
              text: o.text
            });
        });
      },
      /** Server-side alerts can watch this condition (fires when the last bar is true). */
      alertcondition(cond, title, message = "") {
        const arr = Array.isArray(cond) ? cond : new Array(n).fill(cond);
        alerts.push({ title: String(title), message: String(message || title), last: !!arr[n - 1], prev: !!arr[n - 2] });
      },
      log: (...a) => logs.push(a.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")),
      strategy: Object.assign(
        (o) => Object.assign(strategyOpts, o),
        {
          onBar: (fn2) => {
            onBar = fn2;
          },
          entry: (id, side, o) => ctl.get().entry(id, side, o),
          close: (id, reason) => ctl.get().close(id, reason),
          closeAll: (reason = "close all") => ctl.get().close("*", reason),
          position: () => ctl.get().position()
        }
      )
    };
    const names = [...Object.keys(api), ...BLOCKED];
    const values = [...Object.values(api), ...BLOCKED.map(() => void 0)];
    const fn = new Function(...names, `"use strict";
${source}`);
    fn(...values);
    let report = null;
    if (onBar) {
      report = runStrategy(bars, onBar, ctl, strategyOpts);
      for (const t of report.trades) {
        const long = t.side === "long";
        markers.push({ time: t.entryTime, position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: long ? "#2962FF" : "#F23645", text: t.id });
        markers.push({ time: t.exitTime, position: long ? "aboveBar" : "belowBar", shape: "circle", color: "#787B86", text: t.pnl >= 0 ? `+${t.pnl.toFixed(0)}` : t.pnl.toFixed(0) });
      }
    }
    return {
      name: meta.name,
      overlay: meta.overlay,
      kind: onBar ? "strategy" : "indicator",
      inputs,
      plots,
      plotData,
      hlines,
      markers: markers.sort((a, b) => a.time - b.time),
      strategy: report,
      alerts,
      logs
    };
  }
  return __toCommonJS(engine_exports);
})();
