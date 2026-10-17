#!/usr/bin/env python3
"""SeatRelay cloud-vs-on-premise cost model (execution plan section 6; method in docs/COST.md).

Reads pricing.json (ap-southeast-1 unit prices) and onprem.json (on-premise assumptions) from
the same directory, derives monthly usage from a registrations-per-month workload model, prices
it in the three cloud layers (list price, after free tier, after credits), prices the on-premise
reference in two views (hardware increment only, fully amortised incl. labour), finds the
crossover points and writes:

  results/cost/model-summary.md   tables (tiers, per-dimension usage, on-prem, crossover)
  results/cost/crossover.png      monthly cost vs registrations/month
  results/cost/unit-cost.png      USD per 1,000 registrations per tier
  results/cost/usage-priced.md    only with --usage / --from-snapshot (measured usage, priced)

Examples
  python3 tools/experiments/cost/model.py
  python3 tools/experiments/cost/model.py --tiers 500 5000 50000 --legacy-free-tier
  python3 tools/experiments/cost/model.py --usage results/cost/usage-2026-11.json
  python3 tools/experiments/cost/model.py --from-snapshot results/cost/snapshots/2026-11-05.json

--usage takes a flat JSON object {pricing_key: monthly_quantity, ..., "registrations": N}
(keys = pricing.json "prices" keys; "registrations" is optional and only used for the unit cost).
--from-snapshot reads the file written by tools/scripts/bin/cost-snapshot.sh, sums UsageQuantity
per Cost Explorer usage type over the period and maps the usage types to pricing keys.

Dependencies: Python 3.9+, pandas, matplotlib (nothing else).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
HOURS_PER_MONTH = 730.0
DAYS_PER_MONTH = 30.0

# ----------------------------------------------------------------------------- workload model


@dataclass
class Workload:
    """Per-registration usage drivers (plan section 1.3 polling protocol, section 2.4 sizing)."""

    commands_per_registration: float = 2.5  # REGISTER + ACCEPT/DECLINE/CANCEL + ticks that settle
    reads_per_command: float = 6.0  # GET /commands/{id} polling + page refreshes per command
    offers_per_registration: float = 1.2  # initial offer + backfill re-offers => one timer each
    emails_per_registration: float = 2.0  # offer + confirmation (expiry/cancel mails are rarer)
    # Lambda sizing (memory MB, duration ms); api/worker per plan section 2.4, others measured-small
    api_mb: int = 512
    api_ms: float = 150.0
    worker_mb: int = 1024
    worker_ms: float = 400.0
    forwarder_mb: int = 512
    forwarder_ms: float = 50.0
    notifier_mb: int = 512
    notifier_ms: float = 300.0
    sweep_mb: int = 512
    sweep_ms: float = 200.0
    # DynamoDB per command (plan section 2.3): snapshot query ~4 RRU, transaction ~12 WCU x2
    snapshot_rru_per_command: float = 4.0
    rru_per_api_read: float = 2.0  # GET /commands/{id} is 1 RRU, workshop views ~4 RRU
    txn_wru_per_command: float = 24.0  # 12 WCU x 2 (TransactWriteItems)
    cmd_accept_wru: float = 1.0  # conditional put of the ACCEPTED command record
    notifier_wru_per_email: float = 1.0  # status update FAILED/SENT
    stream_records_per_registration: float = 6.0  # one stream record per item written
    item_kb_per_registration: float = 6.0  # registration, offer, cmd result, notifications ...
    data_retention_days: float = 90.0  # TTL on settled items
    # Front end (CloudFront): index.html no-cache + hashed assets immutable
    visits_per_registration: float = 3.0
    cf_mb_per_visit: float = 0.6
    cf_requests_per_visit: float = 8.0
    s3_miss_fraction: float = 0.05  # CloudFront misses that hit S3
    api_response_kb: float = 2.0  # regional data transfer out per API response
    # Observability
    logs_kb_per_invocation: float = 1.5  # Powertools JSON line + START/END/REPORT
    access_log_kb_per_request: float = 0.4  # HTTP API access log line
    log_retention_days: float = 14.0  # app.yaml LogRetentionDays
    xray_sampling: float = 1.0  # fraction of invocations traced (default rule: 1 req/s + 5%)
    # Fixed monthly items (independent of registrations)
    sweep_invocations: float = 12 * 24 * DAYS_PER_MONTH  # rate(5 minutes)
    sqs_idle_polling_fifo: float = 5 * 3 * 60 * 24 * DAYS_PER_MONTH  # 5 pollers x 20 s long poll
    sqs_idle_polling_standard: float = 5 * 3 * 60 * 24 * DAYS_PER_MONTH
    dashboards: float = 1.0
    alarms: float = 7.0
    custom_metrics: float = 8.0  # 7 metric names x {service} dimension (+ a spare)
    cw_api_requests: float = 50_000.0  # dashboard refreshes, experiment metric fetches
    xray_traces_retrieved: float = 10_000.0
    sns_email_notifications: float = 20.0
    sns_api_requests: float = 20.0
    s3_storage_gb: float = 0.05  # SPA build + SAM artefacts
    s3_put_requests: float = 200.0  # deployments
    mau_per_registration: float = 1.0 / 3.0  # Cognito MAU ~ registrations / 3


def gb_seconds(mb: int, ms: float, invocations: float) -> float:
    return invocations * (mb / 1024.0) * (ms / 1000.0)


def derive_usage(registrations: float, w: Workload, charge_stream_reads: bool = False) -> dict[str, float]:
    """Monthly quantity per pricing.json key for a given number of registrations per month."""
    r = registrations
    commands = r * w.commands_per_registration
    api_reqs = commands * (1 + w.reads_per_command)
    timers = r * w.offers_per_registration
    emails = r * w.emails_per_registration
    worker_inv = commands
    forwarder_inv = timers  # BatchSize 10, but timers are spread in time => ~1 per invocation
    notifier_inv = emails  # BatchSize 10 / 1 s window; at these rates ~1 record per batch
    sweep_inv = w.sweep_invocations
    invocations = api_reqs + worker_inv + forwarder_inv + notifier_inv + sweep_inv

    gbs = (
        gb_seconds(w.api_mb, w.api_ms, api_reqs)
        + gb_seconds(w.worker_mb, w.worker_ms, worker_inv)
        + gb_seconds(w.forwarder_mb, w.forwarder_ms, forwarder_inv)
        + gb_seconds(w.notifier_mb, w.notifier_ms, notifier_inv)
        + gb_seconds(w.sweep_mb, w.sweep_ms, sweep_inv)
    )
    # SQS: command = Send + Receive + Delete on the FIFO; timer = 3 on the delay queue
    # + forwarder Send to FIFO + worker Receive/Delete of the TICK
    fifo = commands * 3 + timers * 3 + w.sqs_idle_polling_fifo
    standard = timers * 3 + w.sqs_idle_polling_standard
    rru = commands * (w.snapshot_rru_per_command + w.reads_per_command * w.rru_per_api_read)
    wru = commands * (w.txn_wru_per_command + w.cmd_accept_wru) + emails * w.notifier_wru_per_email
    table_gb = r * w.item_kb_per_registration / 1024 / 1024 * (w.data_retention_days / DAYS_PER_MONTH)
    stream_rru = r * w.stream_records_per_registration if charge_stream_reads else 0.0
    cf_gb = r * w.visits_per_registration * w.cf_mb_per_visit / 1024
    cf_requests = r * w.visits_per_registration * w.cf_requests_per_visit
    logs_gb = (invocations * w.logs_kb_per_invocation + api_reqs * w.access_log_kb_per_request) / 1024 / 1024
    traces = (api_reqs + worker_inv + forwarder_inv + notifier_inv) * w.xray_sampling + sweep_inv

    return {
        "lambda_request_arm": invocations,
        "lambda_gbs_arm": gbs,
        "http_api_request": api_reqs,
        "sqs_request_fifo": fifo,
        "sqs_request_standard": standard,
        "ddb_rru_ondemand": rru,
        "ddb_wru_ondemand": wru,
        "ddb_storage_gb_month": table_gb,
        "ddb_pitr_gb_month": table_gb,
        "ddb_streams_rru": stream_rru,
        "ses_email_essentials": emails,
        "cloudfront_dto_gb_asia": cf_gb,
        "cloudfront_https_request_asia": cf_requests,
        "s3_storage_gb_month": w.s3_storage_gb,
        "s3_put_request": w.s3_put_requests,
        "s3_get_request": cf_requests * w.s3_miss_fraction,
        "cw_custom_metric_month": w.custom_metrics,
        "cw_alarm_month": w.alarms,
        "cw_dashboard_month": w.dashboards,
        "cw_logs_ingest_gb": logs_gb,
        "cw_logs_storage_gb_month": logs_gb * (w.log_retention_days / DAYS_PER_MONTH),
        "cw_api_request": w.cw_api_requests,
        "xray_trace_recorded": traces,
        "xray_trace_retrieved": w.xray_traces_retrieved,
        "eventbridge_scheduler_invocation": sweep_inv,
        "cognito_mau_essentials": r * w.mau_per_registration,
        "data_transfer_out_gb": api_reqs * w.api_response_kb / 1024 / 1024,
        "sns_email_notification": w.sns_email_notifications,
        "sns_api_request": w.sns_api_requests,
    }


# ----------------------------------------------------------------------------- pricing


def tiered_cost(qty: float, price: dict) -> float:
    """Cost of qty units under the price's tier schedule ([[upper_bound, usd], ...] or flat usd)."""
    if qty <= 0:
        return 0.0
    tiers = price.get("tiers")
    if not tiers:
        return qty * price["usd"]
    cost, lower = 0.0, 0.0
    for upper, usd in tiers:
        upper = math.inf if upper is None else float(upper)
        take = min(qty, upper) - lower
        if take > 0:
            cost += take * usd
        lower = upper
        if qty <= upper:
            break
    return cost


def swap_keys(usage: dict[str, float], ses_alacarte: bool, cognito_lite: bool) -> dict[str, float]:
    u = dict(usage)
    if ses_alacarte and "ses_email_essentials" in u:
        u["ses_email_alacarte"] = u.pop("ses_email_essentials")
    if cognito_lite and "cognito_mau_essentials" in u:
        u["cognito_mau_lite"] = u.pop("cognito_mau_essentials")
    return u


def price_usage(usage: dict[str, float], prices: dict, legacy_free_tier: bool) -> pd.DataFrame:
    """Per-dimension table with list cost and cost after free-tier allowances."""
    rows = []
    # The SQS free pool (1M requests) covers standard and FIFO together: standard first, then FIFO.
    sqs_pool = prices["sqs_request_standard"].get("free_always", 0)
    if legacy_free_tier:
        sqs_pool += prices["sqs_request_standard"].get("free_12mo", 0)
    for key, qty in usage.items():
        p = prices[key]
        free = p.get("free_always", 0) + (p.get("free_12mo", 0) if legacy_free_tier else 0)
        if key == "sqs_request_standard":
            free = min(sqs_pool, qty)
            sqs_pool -= free
        elif key == "sqs_request_fifo":
            free = min(sqs_pool, qty)
            sqs_pool -= free
        billable = max(0.0, qty - free)
        rows.append(
            {
                "key": key,
                "service": p["service"],
                "dimension": p["dimension"],
                "unit": p["unit"],
                "quantity": qty,
                "unit_usd": p["usd"],
                "free_allowance": free,
                "list_usd": tiered_cost(qty, p),
                "after_free_usd": tiered_cost(billable, p),
                "verification": p.get("verification", "unverified"),
            }
        )
    return pd.DataFrame(rows)


def service_group(service: str) -> str:
    return service.split(" (")[0].replace("Amazon ", "").replace("AWS ", "")


# ----------------------------------------------------------------------------- on-premise


def utilisation(registrations: float, onprem: dict) -> float:
    by_tier = onprem["power"]["utilisation_by_tier"]
    key = str(int(registrations))
    if key in by_tier:
        return float(by_tier[key])
    return min(0.95, max(0.02, 0.02 + 0.18 * registrations / 100_000.0))


def onprem_monthly(registrations: float, onprem: dict, years: int, full_view: bool,
                   server_price_sgd: float | None = None, email_postmark: bool = False) -> dict:
    """Monthly on-premise cost (USD) for one view. full_view=False -> hardware increment only."""
    fx = onprem["fx"]["sgd_per_usd"]
    srv, ups, pw, el, net, bk, em, lab = (onprem[k] for k in
                                          ("server", "ups", "power", "electricity", "network", "backup", "email", "labour"))
    n = max(1, math.ceil(registrations / srv["capacity_registrations_per_month"]))
    months = years * 12
    server_sgd = srv["price_sgd"] if server_price_sgd is None else server_price_sgd
    hardware_sgd = n * (server_sgd + ups["price_sgd"] + bk["external_disk"]["price_sgd"]) / months
    watts = n * (pw["idle_w"] + (pw["load_w"] - pw["idle_w"]) * utilisation(registrations, onprem) + pw["ups_overhead_w"])
    kwh = watts * HOURS_PER_MONTH / 1000.0
    electricity_sgd = kwh * el["tariff_cents_per_kwh_incl_gst"] / 100.0
    if full_view:
        network_sgd = net["dedicated_line"]["monthly_sgd"]
        labour_sgd = lab["hours_per_month"] * lab["sgd_per_hour"]
        backup_gb = registrations / 1000.0 * bk["backup_size_gb_per_1000_registrations_month"] * bk["backup_retention_days"] / DAYS_PER_MONTH
        b2 = bk["object_storage"]
        backup_usd = max(0.0, backup_gb - b2["free_gb"]) * b2["usd_per_gb_month"]
    else:
        inc = net["increment_only"]
        network_sgd = inc["monthly_sgd"] + inc["one_time_sgd"] / inc["one_time_amortisation_months"]
        labour_sgd = 0.0
        backup_usd = 0.0  # the external disk is in hardware_sgd
    emails = registrations * 2.0
    if email_postmark:
        alt = em["alternative"]
        email_usd = 15.0 + max(0.0, emails - 10_000) / 1000.0 * 1.80
    else:
        email_usd = emails / 1000.0 * em["usd_per_1000"]
    parts_usd = {
        "hardware_amortisation": hardware_sgd / fx,
        "electricity": electricity_sgd / fx,
        "network": network_sgd / fx,
        "backup_offsite": backup_usd,
        "email": email_usd,
        "labour": labour_sgd / fx,
    }
    return {"registrations": registrations, "servers": n, "years": years, "view": "full" if full_view else "increment",
            "kwh": kwh, **parts_usd, "total_usd": sum(parts_usd.values())}


# ----------------------------------------------------------------------------- cloud layers


def cloud_layers(registrations: float, prices: dict, w: Workload, args) -> tuple[pd.DataFrame, dict]:
    usage = swap_keys(derive_usage(registrations, w, args.charge_stream_reads), args.ses_alacarte, args.cognito_lite)
    df = price_usage(usage, prices, args.legacy_free_tier)
    layers = {
        "registrations": registrations,
        "list_usd": float(df["list_usd"].sum()),
        "after_free_usd": float(df["after_free_usd"].sum()),
        "after_credits_usd": 0.0,  # credits absorb the whole bill while they last (docs/COST.md section 2)
    }
    return df, layers


def crossover(prices: dict, onprem: dict, w: Workload, args, years: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Scan registrations/month on a log grid; return the curve and the first crossing per pair."""
    grid = [10 ** (e / 12.0) for e in range(24, int(12 * math.log10(args.max_registrations)) + 1)]
    rows = []
    for n in grid:
        _, cl = cloud_layers(n, prices, w, args)
        rows.append({
            "registrations": n,
            "cloud_list": cl["list_usd"],
            "cloud_after_free": cl["after_free_usd"],
            "onprem_increment": onprem_monthly(n, onprem, years, False, args.server_price_sgd, args.email_postmark)["total_usd"],
            "onprem_full": onprem_monthly(n, onprem, years, True, args.server_price_sgd, args.email_postmark)["total_usd"],
        })
    curve = pd.DataFrame(rows)
    found = []
    for c in ("cloud_list", "cloud_after_free"):
        for o in ("onprem_increment", "onprem_full"):
            diff = curve[c] - curve[o]
            idx = diff[diff >= 0].index
            if len(idx) == 0:
                found.append({"cloud_layer": c, "onprem_view": o, "crossover_registrations": None,
                              "note": f"cloud stays cheaper up to {args.max_registrations:,.0f}/month"})
                continue
            i = idx[0]
            if i == 0:
                x = curve.loc[0, "registrations"]
            else:  # linear interpolation in log(registrations)
                x0, x1 = curve.loc[i - 1, "registrations"], curve.loc[i, "registrations"]
                d0, d1 = diff[i - 1], diff[i]
                t = d0 / (d0 - d1)
                x = 10 ** (math.log10(x0) + t * (math.log10(x1) - math.log10(x0)))
            found.append({"cloud_layer": c, "onprem_view": o, "crossover_registrations": x,
                          "usd_per_month_at_crossover": float(curve.loc[i, o]), "note": ""})
    return curve, pd.DataFrame(found)


# ----------------------------------------------------------------------------- measured usage


USAGETYPE_MAP = {  # Cost Explorer usage type (ap-southeast-1) -> pricing.json key
    "APS1-Request-ARM": "lambda_request_arm", "APS1-Lambda-GB-Second-ARM": "lambda_gbs_arm",
    "APS1-Request": "lambda_request_arm", "APS1-Lambda-GB-Second": "lambda_gbs_arm",
    "APS1-ApiGatewayHttpRequest": "http_api_request",
    "APS1-Requests-FIFO-Tier1": "sqs_request_fifo", "APS1-Requests-Tier1": "sqs_request_standard",
    "APS1-ReadRequestUnits": "ddb_rru_ondemand", "APS1-WriteRequestUnits": "ddb_wru_ondemand",
    "APS1-TimedStorage-ByteHrs": "ddb_storage_gb_month", "APS1-TimedPITRStorage-ByteHrs": "ddb_pitr_gb_month",
    "APS1-Streams-Requests": "ddb_streams_rru",
    "APS1-Essentials-Outbound-Email": "ses_email_essentials", "APS1-Recipients": "ses_email_alacarte",
    "AP-DataTransfer-Out-Bytes": "cloudfront_dto_gb_asia", "AP-Requests-Tier2-HTTPS": "cloudfront_https_request_asia",
    "APS1-Requests-Tier2": "s3_get_request",
    "APS1-CW:MetricMonitorUsage": "cw_custom_metric_month", "APS1-CW:AlarmMonitorUsage": "cw_alarm_month",
    "APS1-DataProcessing-Bytes": "cw_logs_ingest_gb", "APS1-CW:Requests": "cw_api_request",
    "APS1-XRay-TracesStored": "xray_trace_recorded", "APS1-XRay-TracesAccessed": "xray_trace_retrieved",
    "APS1-ScheduledInvocation": "eventbridge_scheduler_invocation",
    "APS1-CognitoEssentialsMAU": "cognito_mau_essentials", "APS1-CognitoLiteMAU": "cognito_mau_lite",
    "APS1-DataTransfer-Out-Bytes": "data_transfer_out_gb",
    "APS1-DeliveryAttempts-SMTP": "sns_email_notification",
}


def snapshot_filter_note(snap: dict) -> str:
    """Whether the snapshot's usage-by-type query was limited to the Project=SeatRelay tag.
    Snapshots written before cost-snapshot.sh recorded it were not filtered."""
    flags = snap.get("filter")
    if not isinstance(flags, dict) or "byUsageType" not in flags:
        return ("Usage by type in this snapshot is **not filtered** to Project=SeatRelay (snapshot "
                "predates the filter): it covers every workload of the account.")
    if flags.get("byUsageType"):
        return "Usage by type is filtered to the cost allocation tag Project=SeatRelay."
    return ("Usage by type is **not filtered** to Project=SeatRelay (the tag filter failed, e.g. the tag "
            "was not active yet): it covers every workload of the account.")


def usage_from_snapshot(path: Path) -> tuple[dict[str, float], list[str]]:
    snap = json.loads(path.read_text())
    totals: dict[str, float] = {}
    for period in snap["byUsageType"]["ResultsByTime"]:
        for g in period["Groups"]:
            ut = g["Keys"][0]
            totals[ut] = totals.get(ut, 0.0) + float(g["Metrics"]["UsageQuantity"]["Amount"])
    usage: dict[str, float] = {}
    unmapped = []
    for ut, qty in totals.items():
        key = USAGETYPE_MAP.get(ut)
        if key is None:
            # SQS usage types are ambiguous across services (S3 also uses Requests-Tier1); keep as-is
            unmapped.append(f"{ut} ({qty:,.0f})")
            continue
        usage[key] = usage.get(key, 0.0) + qty
    return usage, unmapped


# ----------------------------------------------------------------------------- output helpers


def md_table(df: pd.DataFrame, floats: str = "{:,.4f}") -> str:
    cols = list(df.columns)
    out = ["| " + " | ".join(cols) + " |", "|" + "|".join(["---"] * len(cols)) + "|"]
    for _, row in df.iterrows():
        cells = []
        for c in cols:
            v = row[c]
            if isinstance(v, float):
                cells.append("" if math.isnan(v) else (floats.format(v) if abs(v) < 1e6 else f"{v:,.0f}"))
            elif v is None:
                cells.append("")
            else:
                cells.append(str(v))
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


def fmt_qty(v: float) -> str:
    if v == 0:
        return "0"
    if abs(v) >= 1000:
        return f"{v:,.0f}"
    if abs(v) >= 1:
        return f"{v:,.2f}"
    return f"{v:.4g}"


PALETTE = {"blue": "#2a78d6", "orange": "#eb6834", "aqua": "#1baf7a", "yellow": "#eda100"}  # validated light slots 1-4
INK = {"primary": "#0b0b0b", "secondary": "#52514e", "muted": "#8a8984", "grid": "#e6e5e1", "surface": "#fcfcfb"}


def style_axes(ax):
    ax.set_facecolor(INK["surface"])
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(INK["grid"])
    ax.tick_params(colors=INK["secondary"], labelsize=9)
    ax.grid(True, which="major", color=INK["grid"], linewidth=0.8)
    ax.grid(False, which="minor")
    ax.set_axisbelow(True)


def plot_crossover(curve: pd.DataFrame, cross: pd.DataFrame, path: Path, years: int):
    fig, ax = plt.subplots(figsize=(9, 5.4), dpi=160)
    fig.patch.set_facecolor(INK["surface"])
    style_axes(ax)
    series = [
        ("cloud_list", "Cloud, list price", PALETTE["blue"], "-"),
        ("cloud_after_free", "Cloud, after free tier", PALETTE["orange"], "-"),
        ("onprem_increment", f"On-prem, hardware increment only ({years}-yr)", PALETTE["aqua"], "-"),
        ("onprem_full", f"On-prem, fully amortised incl. labour ({years}-yr)", PALETTE["yellow"], "-"),
    ]
    x = curve["registrations"]
    # direct labels where the lines are well separated (cloud pair at ~400/mo, on-prem pair at ~2,000/mo)
    label_at = {"cloud_list": (400, "Cloud, list", 6), "cloud_after_free": (400, "Cloud, after free tier", -11),
                "onprem_increment": (150, "On-prem, increment only", 6), "onprem_full": (2000, "On-prem, fully amortised", 6)}
    for col, label, color, ls in series:
        ax.plot(x, curve[col], color=color, linewidth=2, linestyle=ls, label=label)
        lx, text, dy = label_at[col]
        ly = float(curve.iloc[(curve["registrations"] - lx).abs().argsort().iloc[0]][col])
        ax.annotate(text, (lx, ly), xytext=(0, dy), textcoords="offset points", fontsize=8, color=INK["secondary"],
                    ha="left", va="bottom" if dy > 0 else "top")
    offsets = {("cloud_list", "onprem_increment"): (-6, 10, "right"), ("cloud_list", "onprem_full"): (-8, 10, "right"),
               ("cloud_after_free", "onprem_increment"): (8, -14, "left"), ("cloud_after_free", "onprem_full"): (8, -14, "left")}
    for _, r in cross.iterrows():
        if r["crossover_registrations"] is None or (isinstance(r["crossover_registrations"], float) and math.isnan(r["crossover_registrations"])):
            continue
        ax.plot([r["crossover_registrations"]], [r["usd_per_month_at_crossover"]], marker="o", markersize=8,
                markerfacecolor=INK["surface"], markeredgecolor=INK["primary"], markeredgewidth=1.5, linestyle="none")
        dx, dy, ha = offsets.get((r["cloud_layer"], r["onprem_view"]), (0, 9, "center"))
        ax.annotate(f"{r['crossover_registrations']:,.0f}/mo", (r["crossover_registrations"], r["usd_per_month_at_crossover"]),
                    xytext=(dx, dy), textcoords="offset points", fontsize=7.5, color=INK["primary"], ha=ha)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("Registrations per month (log scale)", color=INK["secondary"], fontsize=10)
    ax.set_ylabel("USD per month (log scale)", color=INK["secondary"], fontsize=10)
    ax.set_title("SeatRelay monthly cost: cloud (ap-southeast-1) vs on-premise reference", color=INK["primary"], fontsize=12, loc="left")
    ax.legend(frameon=False, fontsize=8.5, loc="upper left", labelcolor=INK["primary"])
    ax.set_xlim(x.min(), x.max() * 1.2)
    fig.tight_layout()
    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)


def plot_unit_cost(tiers_df: pd.DataFrame, path: Path, years: int):
    tiers = list(tiers_df["registrations"])
    fig, axes = plt.subplots(1, len(tiers), figsize=(3.3 * len(tiers) + 1, 4.4), dpi=160, sharex=True)
    fig.patch.set_facecolor(INK["surface"])
    if len(tiers) == 1:
        axes = [axes]
    bars = [
        ("cloud_list_per_1k", "Cloud, list", PALETTE["blue"]),
        ("cloud_after_free_per_1k", "Cloud, after free tier", PALETTE["orange"]),
        ("onprem_increment_per_1k", "On-prem, increment only", PALETTE["aqua"]),
        ("onprem_full_per_1k", "On-prem, fully amortised", PALETTE["yellow"]),
    ]
    xmax = max(float(tiers_df[c].max()) for c, _, _ in bars) * 1.9
    for ax, (_, row) in zip(axes, tiers_df.iterrows()):
        style_axes(ax)
        ys = range(len(bars))[::-1]
        for y, (col, label, color) in zip(ys, bars):
            v = float(row[col])
            ax.barh(y, v, color=color, height=0.62, edgecolor=INK["surface"], linewidth=2)
            ax.text(v * 1.08 if v > 0 else 0.01, y, f"${v:,.2f}", va="center", fontsize=8.5, color=INK["primary"])
        ax.set_yticks(list(ys))
        ax.set_yticklabels([b[1] for b in bars] if ax is axes[0] else [""] * len(bars), fontsize=8.5)
        ax.set_xscale("log")
        ax.set_xlim(0.1, xmax)
        ax.set_title(f"{int(row['registrations']):,} registrations/month", fontsize=10, color=INK["primary"], loc="left")
        ax.set_xlabel("USD per 1,000 registrations (log)", fontsize=9, color=INK["secondary"])
        ax.grid(True, axis="x", color=INK["grid"])
        ax.grid(False, axis="y")
    fig.suptitle(f"Unit cost per 1,000 registrations (on-prem: {years}-year amortisation)", x=0.01, ha="left", fontsize=12, color=INK["primary"])
    fig.tight_layout()
    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)


# ----------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiers", nargs="+", type=float, default=[1_000, 10_000, 100_000], help="registrations/month tiers")
    ap.add_argument("--usage", type=Path, help="JSON {pricing_key: monthly quantity, 'registrations': N} to price")
    ap.add_argument("--from-snapshot", type=Path, help="results/cost/snapshots/<date>.json from cost-snapshot.sh")
    ap.add_argument("--legacy-free-tier", action="store_true", help="also apply 12-month allowances (accounts created before 2025-07-15)")
    ap.add_argument("--charge-stream-reads", action="store_true", help="price DynamoDB Streams reads as if a non-Lambda consumer read them")
    ap.add_argument("--ses-alacarte", action="store_true", help="price e-mail at the a-la-carte SES rate instead of the Essentials plan")
    ap.add_argument("--cognito-lite", action="store_true", help="price Cognito at the Lite tier instead of Essentials")
    ap.add_argument("--email-postmark", action="store_true", help="on-prem: use Postmark Basic instead of SES for e-mail")
    ap.add_argument("--server-price-sgd", type=float, help="on-prem: override the server price (e.g. 438 for the local N150 listing)")
    ap.add_argument("--amortisation-years", type=int, default=3, choices=[3, 4], help="years used for the charts and crossover")
    ap.add_argument("--max-registrations", type=float, default=10_000_000, help="upper end of the crossover scan")
    ap.add_argument("--out", type=Path, default=REPO / "results" / "cost", help="output directory")
    args = ap.parse_args()

    prices = json.loads((HERE / "pricing.json").read_text())["prices"]
    onprem = json.loads((HERE / "onprem.json").read_text())
    w = Workload()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    years = args.amortisation_years

    # ---- tiers
    tier_rows, detail_tables = [], {}
    for n in args.tiers:
        df, cl = cloud_layers(n, prices, w, args)
        detail_tables[n] = df
        inc3 = onprem_monthly(n, onprem, 3, False, args.server_price_sgd, args.email_postmark)
        inc4 = onprem_monthly(n, onprem, 4, False, args.server_price_sgd, args.email_postmark)
        full3 = onprem_monthly(n, onprem, 3, True, args.server_price_sgd, args.email_postmark)
        full4 = onprem_monthly(n, onprem, 4, True, args.server_price_sgd, args.email_postmark)
        chosen_inc, chosen_full = (inc3, full3) if years == 3 else (inc4, full4)
        tier_rows.append({
            "registrations": n,
            "cloud_list_usd": cl["list_usd"], "cloud_after_free_usd": cl["after_free_usd"], "cloud_after_credits_usd": 0.0,
            "onprem_increment_3y_usd": inc3["total_usd"], "onprem_increment_4y_usd": inc4["total_usd"],
            "onprem_full_3y_usd": full3["total_usd"], "onprem_full_4y_usd": full4["total_usd"],
            "cloud_list_per_1k": cl["list_usd"] / n * 1000, "cloud_after_free_per_1k": cl["after_free_usd"] / n * 1000,
            "onprem_increment_per_1k": chosen_inc["total_usd"] / n * 1000, "onprem_full_per_1k": chosen_full["total_usd"] / n * 1000,
        })
    tiers_df = pd.DataFrame(tier_rows)

    curve, cross = crossover(prices, onprem, w, args, years)
    plot_crossover(curve, cross, out / "crossover.png", years)
    plot_unit_cost(tiers_df, out / "unit-cost.png", years)
    curve.to_csv(out / "crossover-curve.csv", index=False)

    # ---- summary markdown
    flags = {k: v for k, v in vars(args).items() if k not in ("out", "usage", "from_snapshot", "tiers")}
    L = []
    L.append("# SeatRelay cost model output\n")
    L.append("Generated by `tools/experiments/cost/model.py` from `pricing.json` (ap-southeast-1 unit prices, retrieved 2026-10-16) "
             "and `onprem.json`. Method: `docs/COST.md`. Options: `" + json.dumps(flags) + "`.\n")
    L.append("## 1. Monthly cost by tier (USD)\n")
    t1 = tiers_df[["registrations", "cloud_list_usd", "cloud_after_free_usd", "cloud_after_credits_usd",
                   "onprem_increment_3y_usd", "onprem_increment_4y_usd", "onprem_full_3y_usd", "onprem_full_4y_usd"]].copy()
    t1.columns = ["registrations/month", "cloud: list price", "cloud: after free tier", "cloud: after credits",
                  "on-prem: increment only (3-yr)", "on-prem: increment only (4-yr)", "on-prem: fully amortised (3-yr)", "on-prem: fully amortised (4-yr)"]
    t1["registrations/month"] = t1["registrations/month"].map(lambda v: f"{v:,.0f}")
    L.append(md_table(t1, "{:,.2f}") + "\n")
    L.append("`cloud: after credits` is 0 by construction while promotional/educational credits remain on the account; "
             "the amount the credits absorb each month is the `after free tier` column (see docs/COST.md section 2).\n")
    L.append(f"## 2. Unit cost per 1,000 registrations (USD; on-prem at {years}-year amortisation)\n")
    t2 = tiers_df[["registrations", "cloud_list_per_1k", "cloud_after_free_per_1k", "onprem_increment_per_1k", "onprem_full_per_1k"]].copy()
    t2.columns = ["registrations/month", "cloud: list", "cloud: after free tier", "on-prem: increment only", "on-prem: fully amortised"]
    t2["registrations/month"] = t2["registrations/month"].map(lambda v: f"{v:,.0f}")
    L.append(md_table(t2, "{:,.2f}") + "\n")
    L.append("![unit cost](unit-cost.png)\n")

    L.append("## 3. Crossover points\n")
    c = cross.copy()
    c["crossover_registrations"] = c["crossover_registrations"].map(lambda v: "" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:,.0f}")
    if "usd_per_month_at_crossover" in c:
        c["usd_per_month_at_crossover"] = c["usd_per_month_at_crossover"].map(lambda v: "" if isinstance(v, float) and math.isnan(v) else f"{v:,.2f}")
    L.append(md_table(c) + "\n")
    L.append("Registrations/month at which the cloud layer becomes more expensive than the on-prem view "
             f"(on-prem at {years}-year amortisation; on-prem adds a second machine above "
             f"{onprem['server']['capacity_registrations_per_month']:,} registrations/month).\n")
    L.append("![crossover](crossover.png)\n")

    L.append("## 4. Cloud cost by service and tier (USD/month, list price -> after free tier)\n")
    svc_rows = {}
    for n, df in detail_tables.items():
        g = df.assign(group=df["service"].map(service_group)).groupby("group")[["list_usd", "after_free_usd"]].sum()
        for grp, r in g.iterrows():
            svc_rows.setdefault(grp, {})[f"{n:,.0f}/mo"] = f"{r['list_usd']:,.2f} -> {r['after_free_usd']:,.2f}"
    svc_df = pd.DataFrame.from_dict(svc_rows, orient="index").fillna("").reset_index().rename(columns={"index": "service"})
    L.append(md_table(svc_df) + "\n")

    L.append("## 5. Usage and price per dimension\n")
    for n, df in detail_tables.items():
        L.append(f"### {n:,.0f} registrations/month\n")
        d = df[["key", "dimension", "quantity", "unit", "unit_usd", "free_allowance", "list_usd", "after_free_usd", "verification"]].copy()
        d["quantity"] = d["quantity"].map(fmt_qty)
        d["free_allowance"] = d["free_allowance"].map(fmt_qty)
        d["unit_usd"] = d["unit_usd"].map(lambda v: f"{v:.7g}")
        d["list_usd"] = d["list_usd"].map(lambda v: f"{v:,.4f}")
        d["after_free_usd"] = d["after_free_usd"].map(lambda v: f"{v:,.4f}")
        L.append(md_table(d) + "\n")

    L.append("## 6. On-premise breakdown (USD/month)\n")
    rows = []
    for n in args.tiers:
        for full in (False, True):
            for yrs in (3, 4):
                r = onprem_monthly(n, onprem, yrs, full, args.server_price_sgd, args.email_postmark)
                rows.append({"registrations/month": f"{n:,.0f}", "view": "fully amortised" if full else "increment only", "years": yrs,
                             "servers": r["servers"], "kWh/month": r["kwh"], "hardware": r["hardware_amortisation"], "electricity": r["electricity"],
                             "network": r["network"], "backup (off-site)": r["backup_offsite"], "e-mail": r["email"], "labour": r["labour"], "total": r["total_usd"]})
    L.append(md_table(pd.DataFrame(rows), "{:,.2f}") + "\n")

    L.append("## 7. Workload assumptions used\n")
    L.append("```json\n" + json.dumps(asdict(w), indent=2) + "\n```\n")
    unverified = [k for k, p in prices.items() if p.get("verification") != "verified_pricelist"]
    L.append("## 8. Verification status\n")
    L.append(f"{len(prices) - len(unverified)} of {len(prices)} unit prices were read from the AWS Price List API; "
             f"not verified from the price list: {', '.join(unverified) if unverified else 'none'}. "
             "Free-tier allowances and on-prem inputs carry their own verification field in the JSON files.\n")
    (out / "model-summary.md").write_text("\n".join(L))

    # ---- measured usage
    measured = None
    unmapped: list[str] = []
    filter_note = None
    if args.from_snapshot:
        measured, unmapped = usage_from_snapshot(args.from_snapshot)
        src = str(args.from_snapshot)
        filter_note = snapshot_filter_note(json.loads(args.from_snapshot.read_text()))
        print(filter_note, file=sys.stderr)
    elif args.usage:
        measured = json.loads(args.usage.read_text())
        src = str(args.usage)
    if measured is not None:
        regs = float(measured.pop("registrations", 0) or 0)
        unknown = [k for k in measured if k not in prices]
        measured = {k: float(v) for k, v in measured.items() if k in prices}
        df = price_usage(measured, prices, args.legacy_free_tier)
        M = [f"# Measured usage priced ({src})\n",
             *([f"{filter_note}\n"] if filter_note else []),
             f"List price: **US${df['list_usd'].sum():,.2f}**; after free tier: **US${df['after_free_usd'].sum():,.2f}**; after credits: US$0.00 while credits last.\n"]
        if regs:
            M.append(f"Unit cost: US${df['list_usd'].sum() / regs * 1000:,.2f} per 1,000 registrations (list), "
                     f"US${df['after_free_usd'].sum() / regs * 1000:,.2f} (after free tier) for {regs:,.0f} registrations.\n")
        d = df[["key", "dimension", "quantity", "unit", "unit_usd", "free_allowance", "list_usd", "after_free_usd", "verification"]].copy()
        d["quantity"] = d["quantity"].map(fmt_qty)
        d["free_allowance"] = d["free_allowance"].map(fmt_qty)
        d["unit_usd"] = d["unit_usd"].map(lambda v: f"{v:.7g}")
        d["list_usd"] = d["list_usd"].map(lambda v: f"{v:,.4f}")
        d["after_free_usd"] = d["after_free_usd"].map(lambda v: f"{v:,.4f}")
        M.append(md_table(d) + "\n")
        if unknown:
            M.append("Ignored keys (not in pricing.json): " + ", ".join(unknown) + "\n")
        if unmapped:
            M.append("Unmapped Cost Explorer usage types (add to USAGETYPE_MAP): " + ", ".join(unmapped) + "\n")
        (out / "usage-priced.md").write_text("\n".join(M))
        print(f"wrote {out / 'usage-priced.md'}")

    print(f"wrote {out / 'model-summary.md'}, crossover.png, unit-cost.png, crossover-curve.csv")
    print(md_table(t1, "{:,.2f}"))
    print()
    print(md_table(t2, "{:,.2f}"))
    print()
    print(md_table(c))


if __name__ == "__main__":
    main()
