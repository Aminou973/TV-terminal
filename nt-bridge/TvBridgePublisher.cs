// TvBridgePublisher — NinjaTrader 8 AddOn
// Streams NT8 market data to the OpenTerminal backend over a localhost TCP
// socket as newline-delimited JSON. Publish-only and dependency-free: NT8
// stability is the top priority (concurrent queue + one background thread,
// no network work on NT data threads).
//
// INSTALL
//   1. Copy this file to:  Documents\NinjaTrader 8\bin\Custom\AddOns\TvBridgePublisher.cs
//   2. Compile (F5 in the NinjaScript Editor, or restart NT8).
//   3. In NT8: New → Tv Bridge Publisher, set symbols (comma-separated, e.g.
//      "ES, NQ, CL, GC"), click Start.
//
// PROTOCOL (one JSON object per line, UTF-8)
//   {"type":"tick","symbol":"ES","ts_ms":1725000000000,"price":4821.25,"size":3,"bid":4821.00,"ask":4821.50}
//   {"type":"status","message":"started"}
//
// The backend reconnects automatically when NT8 restarts.

#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class TvBridgePublisher : NinjaTrader.NinjaScript.AddOnsBase
    {
        private const int DefaultPort = 5555;

        private ConcurrentQueue<string> outbound = new ConcurrentQueue<string>();
        private CancellationTokenSource cts = new CancellationTokenSource();
        private List<Instrument> subscribed = new List<Instrument>();
        private bool running;

        private int port = DefaultPort;
        private string symbolsCsv = "ES, NQ";

        // ---------------------------------------------------------- NT plumbing
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description = "Publishes NT8 market data to the OpenTerminal bridge (localhost TCP NDJSON).";
                Name = "TvBridgePublisher";
            }
            else if (State == State.Active)
            {
                if (Application.Current != null && Application.Current.Dispatcher != null)
                {
                    Application.Current.Dispatcher.InvokeAsync(() => ShowWindow());
                }
            }
            else if (State == State.Terminated)
            {
                StopBridge();
            }
        }

        // -------------------------------------------------------------- window
        private Window bridgeWindow;

        private void ShowWindow()
        {
            if (bridgeWindow != null) { bridgeWindow.Activate(); return; }

            bridgeWindow = new Window
            {
                Title = "OpenTerminal Bridge Publisher",
                Width = 420, Height = 260,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
            };

            var grid = new System.Windows.Controls.Grid { Margin = new Thickness(12) };
            grid.RowDefinitions.Add(new System.Windows.Controls.RowDefinition());
            grid.RowDefinitions.Add(new System.Windows.Controls.RowDefinition());
            grid.RowDefinitions.Add(new System.Windows.Controls.RowDefinition());
            grid.RowDefinitions.Add(new System.Windows.Controls.RowDefinition());

            var symLabel = new System.Windows.Controls.TextBlock { Text = "Symbols (comma-separated):", Margin = new Thickness(0, 0, 0, 4) };
            var symBox = new System.Windows.Controls.TextBox { Text = symbolsCsv, VerticalContentAlignment = VerticalAlignment.Center };
            Grid.SetRow(symLabel, 0); Grid.SetRow(symBox, 1);

            var startBtn = new System.Windows.Controls.Button { Content = "Start", Height = 32, Margin = new Thickness(0, 10, 0, 0) };
            Grid.SetRow(startBtn, 2);

            var statusText = new System.Windows.Controls.TextBlock { Text = "Idle", Foreground = Brushes.Gray, Margin = new Thickness(0, 10, 0, 0), TextWrapping = TextWrapping.Wrap };
            Grid.SetRow(statusText, 3);

            startBtn.Click += (s, e) =>
            {
                if (!running)
                {
                    symbolsCsv = symBox.Text;
                    StartBridge(statusText);
                    startBtn.Content = "Stop";
                }
                else
                {
                    StopBridge();
                    startBtn.Content = "Start";
                    statusText.Text = "Stopped";
                }
            };

            grid.Children.Add(symLabel); grid.Children.Add(symBox);
            grid.Children.Add(startBtn); grid.Children.Add(statusText);
            bridgeWindow.Content = grid;
            bridgeWindow.Closed += (s, e) => { StopBridge(); bridgeWindow = null; };
            bridgeWindow.Show();
        }

        // ------------------------------------------------------------- lifecycle
        private void StartBridge(System.Windows.Controls.TextBlock status)
        {
            running = true;
            cts = new CancellationTokenSource();

            // TCP server on localhost: backend connects as the single client.
            Task.Run(async () =>
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                try
                {
                    listener.Start();
                    SetStatus(status, $"Listening on 127.0.0.1:{port} — waiting for OpenTerminal…");
                    while (!cts.IsCancellationRequested)
                    {
                        var client = await listener.AcceptTcpClientAsync();
                        SetStatus(status, $"OpenTerminal connected — streaming {subscribed.Count} symbol(s)");
                        await PumpClient(client, cts.Token);
                        SetStatus(status, "Client disconnected — waiting for OpenTerminal…");
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex)
                {
                    Print("TvBridge: server error: " + ex.Message);
                }
                finally
                {
                    listener.Stop();
                }
            }, cts.Token);

            // subscribe instruments (NT7-style AddMarketData via bars)
            foreach (var raw in symbolsCsv.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0))
            {
                try
                {
                    var instrument = Instrument.GetInstrument(raw);
                    if (instrument == null) { SetStatus(status, $"Unknown instrument '{raw}'"); continue; }
                    AddDataSeries(instrument, BarsPeriodType.Minute, 1);
                    lock (subscribed) subscribed.Add(instrument);
                }
                catch (Exception ex)
                {
                    Print("TvBridge: subscribe failed for " + raw + ": " + ex.Message);
                }
            }
        }

        private void StopBridge()
        {
            running = false;
            try { cts.Cancel(); } catch { }
        }

        // ------------------------------------------------------------ data pump
        // Runs on an NT data thread — must never block: enqueue and return.
        protected override void OnMarketData(MarketDataEventArgs e)
        {
            if (!running) return;
            if (e.MarketDataType == MarketDataType.Last)
            {
                var frame = string.Format(
                    System.Globalization.CultureInfo.InvariantCulture,
                    "{{\"type\":\"tick\",\"symbol\":\"{0}\",\"ts_ms\":{1},\"price\":{2},\"size\":{3},\"bid\":{4},\"ask\":{5}}}",
                    Escape(e.Instrument.MasterInstrument.Name),
                    new DateTimeOffset(e.Time.ToUniversalTime()).ToUnixTimeMilliseconds(),
                    e.Price.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture),
                    e.Volume,
                    e.Instrument.GetCurrentBid().ToString("0.####", System.Globalization.CultureInfo.InvariantCulture),
                    e.Instrument.GetCurrentAsk().ToString("0.####", System.Globalization.CultureInfo.InvariantCulture));
                outbound.Enqueue(frame);
            }
        }

        // Drains the queue to the connected backend; reconnects on failure.
        private async Task PumpClient(TcpClient client, CancellationToken token)
        {
            try
            {
                client.NoDelay = true;
                using (var stream = client.GetStream())
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    await writer.WriteLineAsync("{\"type\":\"status\",\"message\":\"connected\"}");
                    while (!token.IsCancellationRequested)
                    {
                        if (outbound.TryDequeue(out var line))
                        {
                            await writer.WriteLineAsync(line);
                        }
                        else
                        {
                            await Task.Delay(20, token);
                        }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Print("TvBridge: client error: " + ex.Message);
            }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        private static string Escape(string s)
        {
            return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private void SetStatus(System.Windows.Controls.TextBlock status, string text)
        {
            if (Application.Current != null && Application.Current.Dispatcher != null)
                Application.Current.Dispatcher.InvokeAsync(() => status.Text = text);
        }
    }
}