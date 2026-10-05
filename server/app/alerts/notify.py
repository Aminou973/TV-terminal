"""Alert delivery: webhook, Telegram, email — plus message templating.

Placeholders follow TradingView where it has one: {{ticker}} {{close}} {{open}}
{{high}} {{low}} {{volume}} {{time}} {{timenow}} {{interval}} {{price}}
{{alert}} {{strategy.order.action}} {{strategy.order.contracts}}
{{strategy.order.price}} {{strategy.order.id}}.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import smtplib
import socket
from email.message import EmailMessage
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import Settings

log = logging.getLogger("openterm.notify")

_PLACEHOLDER = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


def render(template: str, ctx: dict[str, Any]) -> str:
    def sub(m: re.Match) -> str:
        v = ctx.get(m.group(1))
        if v is None:
            return m.group(0)
        if isinstance(v, float):
            return f"{v:.10g}"
        return str(v)

    return _PLACEHOLDER.sub(sub, template)


class DeliveryError(Exception):
    pass


async def check_public_url(url: str, allow_private: bool) -> None:
    """Refuse non-http(s) URLs and, unless allowed, hosts on loopback/private networks (SSRF)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise DeliveryError("webhook must be an http(s) URL")
    if allow_private:
        return
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise DeliveryError(f"cannot resolve {p.hostname}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise DeliveryError(f"{p.hostname} resolves to a private address ({ip}); set OPENTERM_ALERTS_ALLOW_PRIVATE_WEBHOOKS")


async def send_webhook(url: str, message: str, meta: dict, settings: Settings) -> str:
    await check_public_url(url, settings.alerts_allow_private_webhooks)
    # a message that is valid JSON is posted as-is (TradingView behaviour); otherwise wrapped
    try:
        body: Any = json.loads(message)
    except ValueError:
        body = {"text": message, **meta}
    async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
        r = await client.post(url, json=body, headers={"User-Agent": "OpenTerminal-Alerts"})
    if r.status_code >= 400:
        raise DeliveryError(f"HTTP {r.status_code}")
    return str(r.status_code)


async def send_telegram(token: str, chat_id: str, message: str) -> str:
    if not token or not chat_id:
        raise DeliveryError("Telegram bot token / chat id not set")
    async with httpx.AsyncClient(timeout=8) as client:
        r = await client.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": message, "disable_web_page_preview": True},
        )
    if r.status_code != 200 or not r.json().get("ok"):
        raise DeliveryError(f"Telegram {r.status_code}: {r.text[:120]}")
    return "ok"


def _send_email_sync(settings: Settings, to: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as s:
        if settings.smtp_tls:
            s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


async def send_email(settings: Settings, to: str, subject: str, body: str) -> str:
    if not settings.smtp_host:
        raise DeliveryError("SMTP is not configured on the server (OPENTERM_SMTP_HOST)")
    if not to:
        raise DeliveryError("no email address in notification settings")
    await asyncio.to_thread(_send_email_sync, settings, to, subject, body)
    return "sent"


async def deliver(notify: dict, prefs: dict, settings: Settings, title: str, message: str, meta: dict) -> str:
    """Send to every channel the alert asks for; returns a short status per channel."""
    jobs: dict[str, Any] = {}
    webhook = notify.get("webhook")
    if webhook is True:
        webhook = prefs.get("webhook_url")
    if isinstance(webhook, str) and webhook.strip():
        jobs["webhook"] = send_webhook(webhook.strip(), message, meta, settings)
    if notify.get("telegram"):
        token = prefs.get("telegram_bot_token") or settings.telegram_bot_token
        jobs["telegram"] = send_telegram(token, prefs.get("telegram_chat_id", ""), message)
    if notify.get("email"):
        jobs["email"] = send_email(settings, prefs.get("email", ""), f"OpenTerminal alert: {title}", message)
    if not jobs:
        return ""
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    parts = []
    for name, res in zip(jobs, results):
        if isinstance(res, Exception):
            log.warning("alert delivery %s failed: %s", name, res)
            parts.append(f"{name}: failed ({res})")
        else:
            parts.append(f"{name}: {res}")
    return " · ".join(parts)
