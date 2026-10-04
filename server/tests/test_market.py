"""Market data: symbol mapping, Yahoo/Forex Factory parsers, demo data, fallback + caching, API."""

from __future__ import annotations

import time
from datetime import date, datetime, timezone

import pandas as pd
import pytest

from app.market import calendar, demo, service as service_mod
from app.market.service import MarketService
from app.market.universe import HEATMAP, OVERVIEW, to_yahoo
from app.market.yahoo import parse_calendar, parse_earnings_history, parse_events, parse_info, parse_news, parse_quotes


def test_to_yahoo():
    assert to_yahoo("AAPL") == "AAPL"
    assert to_yahoo("DEMO:AAPL") == "AAPL"
    assert to_yahoo("SIM:ES") == "ES=F"
    assert to_yahoo("ES 12-25") == "ES=F"
    assert to_yahoo("NQZ5") == "NQ=F"
    assert to_yahoo("ES=F") == "ES=F" and to_yahoo("^GSPC") == "^GSPC" and to_yahoo("EURUSD=X") == "EURUSD=X"
    assert to_yahoo("BINANCE-BTCUSDT") == "BTC-USD"
    assert to_yahoo("NSE:RELIANCE") == "RELIANCE.NS"
    assert to_yahoo("BRK-B") == "BRK-B"


def test_parse_news_both_shapes():
    new = [{"id": "a", "content": {"title": "T1", "summary": "S", "pubDate": "2026-10-01T12:00:00Z",
                                   "provider": {"displayName": "Reuters"}, "canonicalUrl": {"url": "https://x/1"},
                                   "thumbnail": {"resolutions": [{"url": "big", "width": 1000}, {"url": "small", "width": 140}]}}}]
    old = [{"uuid": "b", "title": "T2", "publisher": "AP", "link": "https://x/2", "providerPublishTime": 1759320000,
            "relatedTickers": ["AAPL", "MSFT"]}, {"uuid": "c", "title": "", "link": "https://x/3"}]
    n = parse_news(new, "AAPL") + parse_news(old, "AAPL")
    assert [x["title"] for x in n] == ["T1", "T2"]
    assert n[0]["publisher"] == "Reuters" and n[0]["thumbnail"] == "small"
    assert n[0]["time"] == int(datetime(2026, 10, 1, 12, tzinfo=timezone.utc).timestamp())
    assert n[1]["time"] == 1759320000 and n[1]["tickers"] == ["AAPL", "MSFT"]


def test_parse_info_and_calendar_and_earnings():
    f = parse_info({"longName": "Apple Inc.", "sector": "Technology", "marketCap": 3.4e12, "trailingPE": "33.1",
                    "dividendYield": 0.44, "regularMarketPrice": 230.5, "recommendationKey": "buy", "beta": float("nan")})
    assert f["name"] == "Apple Inc." and f["market_cap"] == 3.4e12 and f["pe"] == 33.1
    assert f["dividend_yield"] == pytest.approx(0.0044)  # percent → fraction
    assert f["price"] == 230.5 and f["recommendation"] == "buy" and f["beta"] is None
    assert parse_info({"dividendRate": 1.0, "currentPrice": 200, "dividendYield": 0.5})["dividend_yield"] == pytest.approx(0.005)
    assert parse_info({"dividendYield": 0.031})["dividend_yield"] == pytest.approx(0.031)  # already a fraction
    cal = parse_calendar({"Earnings Date": [date(2026, 10, 30)], "Earnings Average": 1.6, "Ex-Dividend Date": date(2026, 11, 8)})
    assert cal["next_earnings"] == int(datetime(2026, 10, 30, tzinfo=timezone.utc).timestamp())
    assert cal["eps_estimate"] == 1.6 and cal["ex_dividend"] is not None
    assert parse_calendar(None) == {} or parse_calendar(None)["next_earnings"] is None
    df = pd.DataFrame({"epsEstimate": [1.5, 1.4], "epsActual": [1.6, 1.3], "surprisePercent": [0.0667, -0.0714]},
                      index=pd.to_datetime(["2026-07-31", "2026-04-30"]))
    e = parse_earnings_history(df)
    assert [x["eps_actual"] for x in e] == [1.3, 1.6]  # oldest first
    assert e[1]["surprise_pct"] == pytest.approx(6.67)


def test_parse_events_and_quotes():
    divs = pd.Series([0.25], index=pd.to_datetime(["2026-08-10"], utc=True))
    splits = pd.Series([4.0], index=pd.to_datetime(["2020-08-31"], utc=True))
    ev = parse_events(divs, splits, [{"time": 1_700_000_000, "eps_actual": 1.5, "eps_estimate": 1.4}], 1_900_000_000)
    assert [e["kind"] for e in ev] == ["split", "earnings", "dividend", "earnings"]
    assert ev[-1]["upcoming"] and "1.50 vs 1.40" in ev[1]["label"]
    idx = pd.to_datetime(["2026-10-01", "2026-10-02"])
    df = pd.concat({
        "AAPL": pd.DataFrame({"Open": [1, 1], "High": [1, 1], "Low": [1, 1], "Close": [100.0, 102.0], "Volume": [10, 20]}, index=idx),
        "MSFT": pd.DataFrame({"Open": [1, 1], "High": [1, 1], "Low": [1, 1], "Close": [50.0, float("nan")], "Volume": [5, 0]}, index=idx),
    }, axis=1)
    q = parse_quotes(df, ["AAPL", "MSFT", "NOPE"])
    assert q["AAPL"]["change_pct"] == pytest.approx(2.0) and q["AAPL"]["volume"] == 20 and q["AAPL"]["spark"] == [100.0, 102.0]
    assert q["MSFT"]["prev_close"] is None and q["MSFT"]["change_pct"] is None
    assert "NOPE" not in q


def test_parse_forex_factory():
    rows = calendar.parse_ff([
        {"title": "CPI m/m", "country": "usd", "date": "2026-10-15T08:30:00-04:00", "impact": "High", "forecast": "0.3%", "previous": "0.2%"},
        {"title": "Bank Holiday", "country": "JPY", "date": "2026-10-13T00:00:00-04:00", "impact": "Holiday", "forecast": "", "previous": ""},
        {"title": "", "date": "bad"},
    ])
    assert [r["title"] for r in rows] == ["Bank Holiday", "CPI m/m"]
    assert rows[1]["country"] == "USD" and rows[1]["impact"] == "high" and rows[1]["forecast"] == "0.3%"
    assert rows[0]["impact"] == "holiday" and rows[0]["forecast"] is None


def test_demo_is_deterministic_and_complete():
    now = 1_790_000_000.0
    assert demo.quotes(["AAPL"], now) == demo.quotes(["AAPL"], now)
    assert demo.quotes(["AAPL"], now)["AAPL"] != demo.quotes(["AAPL"], now + 86400)["AAPL"]
    f = demo.fundamentals("AAPL", now)
    assert f["market_cap"] > 1e12 and f["next_earnings"] > now and len(f["earnings"]) == 8
    assert demo.fundamentals("^GSPC", now)["quote_type"] == "INDEX"
    anchored = demo.fundamentals("AAPL", now, price=244.0)
    assert anchored["price"] == 244.0 and anchored["low_52w"] < 244.0 < anchored["high_52w"]
    assert len(demo.news("AAPL", now)) == 6 and all(n["time"] < now for n in demo.news(None, now))
    cal = demo.economic_calendar(now)
    assert len(cal) == 16 and cal == sorted(cal, key=lambda e: e["time"])
    ev = demo.events("AAPL", now)
    assert any(e.get("upcoming") for e in ev)


class FakeYahoo:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = 0

    def _call(self, value):
        self.calls += 1
        if self.fail:
            raise ConnectionError("blocked")
        return value

    def news(self, t):
        return self._call([{"id": f"{t}1", "title": f"{t} news", "url": "u", "time": 1, "publisher": "P"}])

    def fundamentals(self, t):
        return self._call({"symbol": t, "name": "Live Co", "market_cap": 1e9, "earnings": []})

    def events(self, t):
        return self._call([])

    def quotes(self, tickers):
        return self._call({t: {"last": 10.0, "prev_close": 9.0, "change": 1.0, "change_pct": 11.1, "volume": 5.0, "spark": [9, 10]} for t in tickers})

    def market_caps(self, tickers):
        return self._call({t: 2e9 for t in tickers})

    def next_earnings(self, tickers):
        return self._call([{"symbol": "AAPL", "time": int(time.time()) + 86400}])


def test_service_live_path_and_cache():
    y = FakeYahoo()
    svc = MarketService(live=True, yahoo_mod=y, calendar_fetch=lambda url: [{"time": 1, "title": "X"}])
    n = svc.news("DEMO:AAPL")
    assert n["source"] == "live" and n["items"][0]["title"] == "AAPL news"
    svc.news("DEMO:AAPL")
    assert y.calls == 1  # cached
    f = svc.fundamentals("SIM:ES")
    assert f["source"] == "live" and f["yahoo"] == "ES=F" and f["symbol"] == "SIM:ES"
    assert svc.events("AAPL") == {"symbol": "AAPL", "source": "live", "events": []}  # live empty is real
    h = svc.heatmap()
    assert h["source"] == "live" and len(h["tiles"]) == len(HEATMAP) and h["tiles"][0]["market_cap"] == 2e9
    o = svc.overview()
    assert [g["name"] for g in o["groups"]] == list(OVERVIEW) and len(o["gainers"]) == 8
    assert svc.economic_calendar()["source"] == "live"
    e = svc.earnings_calendar(["AAPL"])
    assert e["rows"][0]["name"] == "Apple"


def test_service_falls_back_and_trips_breaker(monkeypatch):
    y = FakeYahoo(fail=True)
    svc = MarketService(live=True, yahoo_mod=y, calendar_fetch=lambda url: (_ for _ in ()).throw(OSError("down")))
    n = svc.news("AAPL")
    assert n["source"] == "demo" and n["items"]
    calls = y.calls
    svc.fundamentals("MSFT")  # yahoo is marked down: no new live attempt
    assert y.calls == calls
    assert svc.economic_calendar()["source"] == "demo"
    assert "yahoo" in svc.status()["down"]
    # after the retry window the live source is tried again
    real = time.monotonic
    monkeypatch.setattr(service_mod.time, "monotonic", lambda: real() + service_mod.DOWN_FOR_S + 1)
    y.fail = False
    assert svc.news("AAPL")["source"] == "live"


def test_service_offline_mode_never_calls_live():
    y = FakeYahoo()
    svc = MarketService(live=False, yahoo_mod=y)
    assert svc.heatmap()["source"] == "demo" and svc.overview()["source"] == "demo"
    assert y.calls == 0


def test_market_api(client_and_headers):
    client, h = client_and_headers
    for path, key in [("/api/market/news", "items"), ("/api/market/news?symbol=SIM:ES", "items"),
                      ("/api/market/heatmap", "tiles"), ("/api/market/overview", "groups"),
                      ("/api/market/calendar", "rows"), ("/api/market/earnings?symbols=AAPL,SIM:ES", "rows"),
                      ("/api/market/events?symbol=AAPL", "events")]:
        r = client.get(path, headers=h)
        assert r.status_code == 200, (path, r.text)
        body = r.json()
        assert body["source"] == "demo" and body[key], path
    f = client.get("/api/market/fundamentals", params={"symbol": "DEMO:MSFT"}, headers=h).json()
    assert f["yahoo"] == "MSFT" and f["pe"] > 0
    es = client.get("/api/market/fundamentals", params={"symbol": "SIM:ES"}, headers=h).json()
    last = client.get("/api/stats", params={"symbol": "SIM:ES"}, headers=h).json()["last"]
    assert es["yahoo"] == "ES=F" and es["price"] == pytest.approx(last, rel=0.01)  # demo anchored to the chart
    assert client.get("/api/market/status", headers=h).json()["live"] is False
    assert client.get("/api/market/news").status_code == 401


@pytest.fixture()
def client_and_headers():
    import uuid

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        r = c.post("/api/auth/register", json={"username": f"mkt-{uuid.uuid4().hex[:8]}", "password": "secret123"})
        assert r.status_code == 200, r.text
        yield c, {"Authorization": f"Bearer {r.json()['access_token']}"}
