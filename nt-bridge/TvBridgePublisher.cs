// TvBridgePublisher — NinjaTrader 8 AddOn for OpenTerminal
//
// Streams NT8 market data to the OpenTerminal backend over a localhost TCP
// socket as newline-delimited JSON, and (opt-in) accepts orders back.
// NT8 stability first: data callbacks only enqueue pre-rendered lines; one
// background task owns the socket. No external DLLs.
//
// INSTALL
//   1. Copy this file to  Documents\NinjaTrader 8\bin\Custom\AddOns\TvBridgePublisher.cs
//   2. NinjaScript Editor → compile (F5).
//   3. Control Center → New → "OpenTerminal Bridge". Enter instruments
//      (full names, e.g. "ES 12-25, NQ 12-25"), click Start.
//
// PROTOCOL (one JSON object per line, UTF-8)
//   NT → backend
//     {"type":"tick","symbol":"ES","contract":"ES 12-25","ts_ms":…,"price":…,"size":…,"bid":…,"ask":…}
//     {"type":"book","symbol":"ES","bids":[[p,s],…],"asks":[[p,s],…]}
//     {"type":"bars","symbol":"ES","tf":"1m","bars":[[time_s,o,h,l,c,v],…]}   (backfill on connect)
//     {"type":"status","message":"…"}
//     {"type":"order_update","ref":"…","order_id":"…","state":"Filled","filled":1,"avg_price":…,"error":""}
//   backend → NT (only when "Allow order routing" is ticked)
//     {"type":"order","ref":"…","account":"Sim101","contract":"ES 12-25","action":"Buy",
//      "order_type":"Market","qty":1,"limit":0,"stop":0}
//     {"type":"cancel","ref":"…"}

#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.ControlCenter;
using NinjaTrader.Gui.Tools;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class TvBridgePublisher : AddOnBase
    {
        private const int Port = 5555;
        private const int MaxQueued = 50000;      // drop data rather than grow without bound
        private const int BackfillDays = 5;

        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        private NTMenuItem menuItem;
        private NTMenuItem newMenu;
        private BridgeWindow window;

        // ------------------------------------------------------------ NT hooks
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description = "Publishes NT8 market data to OpenTerminal (localhost TCP, NDJSON).";
                Name = "OpenTerminal Bridge";
            }
            else if (State == State.Terminated)
            {
                if (window != null) window.Dispatcher.InvokeAsync(() => window.Close());
            }
        }

        // Add "OpenTerminal Bridge" to Control Center → New
        protected override void OnWindowCreated(Window w)
        {
            var cc = w as ControlCenter;
            if (cc == null) return;
            newMenu = cc.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null) return;
            menuItem = new NTMenuItem { Header = "OpenTerminal Bridge", Style = Application.Current.TryFindResource("MainMenuItem") as Style };
            menuItem.Click += (s, e) => Core.Globals.RandomDispatcher.BeginInvoke(new Action(() =>
            {
                if (window == null) { window = new BridgeWindow(); window.Closed += (a, b) => window = null; window.Show(); }
                else window.Activate();
            }));
            newMenu.Items.Add(menuItem);
        }

        protected override void OnWindowDestroyed(Window w)
        {
            if (menuItem != null && w is ControlCenter)
            {
                if (newMenu != null && newMenu.Items.Contains(menuItem)) newMenu.Items.Remove(menuItem);
                menuItem = null;
                newMenu = null;
            }
        }

        // =====================================================================
        // The bridge itself lives in its window so it starts/stops with it.
        // =====================================================================
        public class BridgeWindow : NTWindow
        {
            private readonly TextBox symbolsBox;
            private readonly CheckBox routeBox;
            private readonly TextBox accountsBox;
            private readonly TextBlock statusText;
            private readonly Button startBtn;

            private readonly ConcurrentQueue<string> outbound = new ConcurrentQueue<string>();
            private CancellationTokenSource cts;
            private TcpListener listener;
            private volatile bool running;
            private volatile bool clientConnected;

            private readonly List<MarketData> marketData = new List<MarketData>();
            private readonly List<MarketDepth<MarketDepthRow>> depth = new List<MarketDepth<MarketDepthRow>>();
            private readonly List<Instrument> instruments = new List<Instrument>();
            private readonly ConcurrentDictionary<string, DateTime> lastBookSent = new ConcurrentDictionary<string, DateTime>();

            // order routing
            private volatile bool routingAllowed;
            private HashSet<string> allowedAccounts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private readonly ConcurrentDictionary<string, Order> ordersByRef = new ConcurrentDictionary<string, Order>();
            private readonly List<Account> watchedAccounts = new List<Account>();

            public BridgeWindow()
            {
                Caption = "OpenTerminal Bridge";
                Width = 460; Height = 340;
                WindowStartupLocation = WindowStartupLocation.CenterScreen;

                var grid = new Grid { Margin = new Thickness(12) };
                for (int i = 0; i < 8; i++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

                Add(grid, new TextBlock { Text = "Instruments (comma-separated, e.g. ES 12-25, NQ 12-25):", Margin = new Thickness(0, 0, 0, 4) }, 0);
                symbolsBox = new TextBox { Text = "ES 12-25, NQ 12-25" };
                Add(grid, symbolsBox, 1);

                routeBox = new CheckBox { Content = "Allow order routing from OpenTerminal", Margin = new Thickness(0, 10, 0, 0), IsChecked = false };
                Add(grid, routeBox, 2);
                Add(grid, new TextBlock { Text = "Accounts allowed to receive orders:", Margin = new Thickness(0, 6, 0, 4) }, 3);
                accountsBox = new TextBox { Text = "Sim101" };
                Add(grid, accountsBox, 4);

                startBtn = new Button { Content = "Start", Height = 30, Margin = new Thickness(0, 12, 0, 0) };
                startBtn.Click += (s, e) => { if (running) StopBridge(); else StartBridge(); };
                Add(grid, startBtn, 5);

                statusText = new TextBlock { Text = "Idle", Margin = new Thickness(0, 10, 0, 0), TextWrapping = TextWrapping.Wrap };
                Add(grid, statusText, 6);

                Content = grid;
                Closing += (s, e) => StopBridge();
            }

            private static void Add(Grid g, UIElement el, int row) { Grid.SetRow(el, row); g.Children.Add(el); }

            private void SetStatus(string text)
            {
                Dispatcher.InvokeAsync(() => statusText.Text = text);
            }

            // ------------------------------------------------------- lifecycle
            private void StartBridge()
            {
                routingAllowed = routeBox.IsChecked == true;
                allowedAccounts = new HashSet<string>(
                    accountsBox.Text.Split(',').Select(a => a.Trim()).Where(a => a.Length > 0), StringComparer.OrdinalIgnoreCase);
                cts = new CancellationTokenSource();
                running = true;
                startBtn.Content = "Stop";
                symbolsBox.IsEnabled = routeBox.IsEnabled = accountsBox.IsEnabled = false;

                foreach (var raw in symbolsBox.Text.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0))
                {
                    var instrument = Instrument.GetInstrument(raw);
                    if (instrument == null) { SetStatus("Unknown instrument '" + raw + "'"); continue; }
                    instruments.Add(instrument);

                    var md = new MarketData(instrument);
                    md.Update += OnMarketData;
                    marketData.Add(md);

                    var mdep = new MarketDepth<MarketDepthRow>(instrument);
                    mdep.Update += OnMarketDepth;
                    depth.Add(mdep);
                }

                if (routingAllowed)
                {
                    lock (Account.All)
                        foreach (var acct in Account.All.Where(a => allowedAccounts.Contains(a.Name)))
                        {
                            acct.OrderUpdate += OnOrderUpdate;
                            watchedAccounts.Add(acct);
                        }
                }

                var token = cts.Token;
                Task.Run(() => ServeLoop(token), token);
            }

            private void StopBridge()
            {
                if (!running) return;
                running = false;
                try { cts.Cancel(); } catch { }
                try { if (listener != null) listener.Stop(); } catch { }   // unblocks AcceptTcpClientAsync

                foreach (var md in marketData) md.Update -= OnMarketData;
                foreach (var d in depth) d.Update -= OnMarketDepth;
                foreach (var a in watchedAccounts) a.OrderUpdate -= OnOrderUpdate;
                marketData.Clear(); depth.Clear(); instruments.Clear(); watchedAccounts.Clear();
                string ignored; while (outbound.TryDequeue(out ignored)) { }

                Dispatcher.InvokeAsync(() =>
                {
                    startBtn.Content = "Start";
                    symbolsBox.IsEnabled = routeBox.IsEnabled = accountsBox.IsEnabled = true;
                    statusText.Text = "Stopped";
                });
            }

            // ---------------------------------------------------------- socket
            private async Task ServeLoop(CancellationToken token)
            {
                listener = new TcpListener(IPAddress.Loopback, Port);
                try
                {
                    listener.Start();
                    SetStatus("Listening on 127.0.0.1:" + Port + " — waiting for OpenTerminal…");
                    while (!token.IsCancellationRequested)
                    {
                        TcpClient client = await listener.AcceptTcpClientAsync();
                        // anything queued while nobody listened is stale
                        string stale; while (outbound.TryDequeue(out stale)) { }
                        clientConnected = true;
                        SetStatus("OpenTerminal connected — streaming " + instruments.Count + " instrument(s)"
                                  + (routingAllowed ? " · order routing ON (" + string.Join(", ", allowedAccounts) + ")" : ""));
                        RequestBackfill();
                        await PumpClient(client, token);
                        clientConnected = false;
                        if (!token.IsCancellationRequested) SetStatus("OpenTerminal disconnected — waiting…");
                    }
                }
                catch (ObjectDisposedException) { }        // listener stopped
                catch (SocketException ex) { if (!token.IsCancellationRequested) SetStatus("Socket error: " + ex.Message); }
                catch (Exception ex) { NinjaTrader.Code.Output.Process("OpenTerminal bridge: " + ex, PrintTo.OutputTab1); }
                finally { try { listener.Stop(); } catch { } }
            }

            private async Task PumpClient(TcpClient client, CancellationToken token)
            {
                try
                {
                    client.NoDelay = true;
                    using (client)
                    using (var stream = client.GetStream())
                    using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = false, NewLine = "\n" })
                    using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
                    {
                        var readTask = ReadLoop(reader, token);
                        await writer.WriteLineAsync("{\"type\":\"status\",\"message\":\"connected\"}");
                        await writer.FlushAsync();
                        while (!token.IsCancellationRequested && !readTask.IsCompleted)
                        {
                            string line; int n = 0;
                            while (n < 500 && outbound.TryDequeue(out line)) { await writer.WriteLineAsync(line); n++; }
                            if (n > 0) await writer.FlushAsync();
                            else await Task.Delay(15, token);
                        }
                    }
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }                      // client went away
                catch (Exception ex) { NinjaTrader.Code.Output.Process("OpenTerminal bridge client: " + ex.Message, PrintTo.OutputTab1); }
            }

            private async Task ReadLoop(StreamReader reader, CancellationToken token)
            {
                while (!token.IsCancellationRequested)
                {
                    string line = await reader.ReadLineAsync();
                    if (line == null) return;                // closed
                    try { HandleCommand(line); }
                    catch (Exception ex) { Enqueue("{\"type\":\"status\",\"message\":" + Q("bad command: " + ex.Message) + "}"); }
                }
            }

            private void Enqueue(string line)
            {
                if (!clientConnected) return;
                if (outbound.Count > MaxQueued) return;
                outbound.Enqueue(line);
            }

            // ------------------------------------------------------- data in
            // NT data threads: render and enqueue only.
            private void OnMarketData(object sender, MarketDataEventArgs e)
            {
                if (!running || e.MarketDataType != MarketDataType.Last) return;
                var inst = e.Instrument;
                Enqueue(string.Format(Inv,
                    "{{\"type\":\"tick\",\"symbol\":{0},\"contract\":{1},\"ts_ms\":{2},\"price\":{3},\"size\":{4},\"bid\":{5},\"ask\":{6}}}",
                    Q(inst.MasterInstrument.Name), Q(inst.FullName), ToUnixMs(e.Time),
                    N(e.Price), e.Volume, N(inst.MarketData.Bid != null ? inst.MarketData.Bid.Price : 0),
                    N(inst.MarketData.Ask != null ? inst.MarketData.Ask.Price : 0)));
            }

            private void OnMarketDepth(object sender, MarketDepthEventArgs e)
            {
                if (!running) return;
                var inst = e.Instrument;
                var key = inst.FullName;
                DateTime last;
                if (lastBookSent.TryGetValue(key, out last) && (DateTime.UtcNow - last).TotalMilliseconds < 250) return;
                lastBookSent[key] = DateTime.UtcNow;
                var book = sender as MarketDepth<MarketDepthRow>;
                if (book == null) return;
                string bids, asks;
                lock (book.Bids) bids = Levels(book.Bids);
                lock (book.Asks) asks = Levels(book.Asks);
                Enqueue("{\"type\":\"book\",\"symbol\":" + Q(inst.MasterInstrument.Name) + ",\"bids\":" + bids + ",\"asks\":" + asks + "}");
            }

            private static string Levels(List<MarketDepthRow> rows)
            {
                var sb = new StringBuilder("[");
                int n = Math.Min(10, rows.Count);
                for (int i = 0; i < n; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('[').Append(N(rows[i].Price)).Append(',').Append(rows[i].Volume.ToString(Inv)).Append(']');
                }
                return sb.Append(']').ToString();
            }

            // ------------------------------------------------------- backfill
            private void RequestBackfill()
            {
                foreach (var inst in instruments.ToList())
                {
                    var instrument = inst;
                    var request = new BarsRequest(instrument, DateTime.Now.AddDays(-BackfillDays), DateTime.Now)
                    {
                        BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 },
                        TradingHours = instrument.MasterInstrument.TradingHours,
                    };
                    request.Request((bars, error, message) =>
                    {
                        try
                        {
                            if (error != ErrorCode.NoError) { Enqueue("{\"type\":\"status\",\"message\":" + Q("backfill " + instrument.FullName + ": " + message) + "}"); return; }
                            var sb = new StringBuilder();
                            sb.Append("{\"type\":\"bars\",\"symbol\":").Append(Q(instrument.MasterInstrument.Name)).Append(",\"tf\":\"1m\",\"bars\":[");
                            for (int i = 0; i < bars.Bars.Count; i++)
                            {
                                if (i > 0) sb.Append(',');
                                // NT stamps a bar with its END time (local tz); OpenTerminal wants the start in UTC
                                long start = ToUnixMs(bars.Bars.GetTime(i).AddMinutes(-1)) / 1000;
                                sb.Append('[').Append(start.ToString(Inv)).Append(',')
                                  .Append(N(bars.Bars.GetOpen(i))).Append(',').Append(N(bars.Bars.GetHigh(i))).Append(',')
                                  .Append(N(bars.Bars.GetLow(i))).Append(',').Append(N(bars.Bars.GetClose(i))).Append(',')
                                  .Append(bars.Bars.GetVolume(i).ToString(Inv)).Append(']');
                            }
                            sb.Append("]}");
                            Enqueue(sb.ToString());
                        }
                        finally { request.Dispose(); }
                    });
                }
            }

            // --------------------------------------------------- order route
            private void HandleCommand(string line)
            {
                string type = Field(line, "type");
                if (type == "order") PlaceOrder(line);
                else if (type == "cancel") CancelOrder(Field(line, "ref"));
            }

            private void PlaceOrder(string line)
            {
                string reference = Field(line, "ref");
                if (!routingAllowed) { Reply(reference, "", "Rejected", 0, 0, "order routing is disabled in the NT8 bridge window"); return; }
                string accountName = Field(line, "account");
                if (!allowedAccounts.Contains(accountName)) { Reply(reference, "", "Rejected", 0, 0, "account '" + accountName + "' is not allowed in the bridge"); return; }
                Account account;
                lock (Account.All) account = Account.All.FirstOrDefault(a => a.Name == accountName);
                var instrument = Instrument.GetInstrument(Field(line, "contract"));
                if (account == null || instrument == null) { Reply(reference, "", "Rejected", 0, 0, "unknown account or contract"); return; }

                OrderAction action = Field(line, "action") == "Sell" ? OrderAction.Sell : OrderAction.Buy;
                string ot = Field(line, "order_type");
                OrderType orderType = ot == "Limit" ? OrderType.Limit : ot == "StopMarket" ? OrderType.StopMarket : OrderType.Market;
                int qty = (int)Num(line, "qty");
                double limit = Num(line, "limit"), stop = Num(line, "stop");
                if (qty <= 0) { Reply(reference, "", "Rejected", 0, 0, "qty must be positive"); return; }

                Order order = account.CreateOrder(instrument, action, orderType, OrderEntry.Manual, TimeInForce.Day,
                                                  qty, limit, stop, string.Empty, "OT-" + reference, Core.Globals.MaxDate, null);
                ordersByRef[reference] = order;
                account.Submit(new[] { order });
            }

            private void CancelOrder(string reference)
            {
                Order order;
                if (ordersByRef.TryGetValue(reference, out order)) order.Account.Cancel(new[] { order });
            }

            private void OnOrderUpdate(object sender, OrderEventArgs e)
            {
                var name = e.Order.Name ?? "";
                if (!name.StartsWith("OT-")) return;      // only orders this bridge placed
                Reply(name.Substring(3), e.Order.OrderId, e.OrderState.ToString(), e.Filled, e.AverageFillPrice, e.Error == ErrorCode.NoError ? "" : e.Comment);
            }

            private void Reply(string reference, string orderId, string state, int filled, double avg, string error)
            {
                Enqueue(string.Format(Inv,
                    "{{\"type\":\"order_update\",\"ref\":{0},\"order_id\":{1},\"state\":{2},\"filled\":{3},\"avg_price\":{4},\"error\":{5}}}",
                    Q(reference), Q(orderId ?? ""), Q(state), filled, N(avg), Q(error ?? "")));
            }

            // --------------------------------------------------------- helpers
            private static long ToUnixMs(DateTime t)
            {
                // NT times are in the platform time zone
                var utc = t.Kind == DateTimeKind.Utc ? t : TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(t, DateTimeKind.Unspecified), Core.Globals.GeneralOptions.TimeZoneInfo);
                return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
            }

            private static string N(double v) { return v.ToString("0.########", Inv); }

            private static string Q(string s)
            {
                var sb = new StringBuilder("\"");
                foreach (char c in s ?? "")
                {
                    if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                    else if (c < 0x20) sb.AppendFormat(Inv, "\\u{0:x4}", (int)c);
                    else sb.Append(c);
                }
                return sb.Append('"').ToString();
            }

            // Minimal flat-JSON field readers for the backend's simple command frames.
            private static string Field(string json, string key)
            {
                var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                return m.Success ? Regex.Unescape(m.Groups[1].Value) : "";
            }

            private static double Num(string json, string key)
            {
                var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?[0-9.eE+]+)");
                double v;
                return m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, Inv, out v) ? v : 0;
            }
        }
    }
}
