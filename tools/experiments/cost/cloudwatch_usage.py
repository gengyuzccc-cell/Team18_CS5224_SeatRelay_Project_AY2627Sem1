#!/usr/bin/env python3
"""Measured SeatRelay AWS usage for one UTC window, read from CloudWatch metrics (method: docs/COST.md).

Cost Explorer lags about a day, so the usage of an experiment day is taken from the service metrics
instead. The script discovers the resources of the SeatRelay CloudFormation stacks
(list-stack-resources), reads the billing-relevant AWS/* metrics for the window with GetMetricData,
converts them to the quantities that pricing.json prices and writes:

  results/cost/usage-<date>-cloudwatch.json   flat {pricing_key: quantity} object for model.py --usage
  results/cost/usage-<date>-cloudwatch.md     per resource: metric, raw values, conversion, mapped key;
                                              window, assumptions and uncertainty

With --price it then runs `model.py --usage <json>` with --out set to a temporary directory (model.py
always rewrites model-summary.md, crossover-curve.csv and the two charts in its --out directory, which
must not be clobbered by a usage run) and copies the priced table to
results/cost/usage-<date>-cloudwatch-priced.md and to results/cost/usage-priced.md, the file that
report/tools/report_numbers.py parses for the measured-usage numbers.

Examples
  python3 tools/experiments/cost/cloudwatch_usage.py
  python3 tools/experiments/cost/cloudwatch_usage.py --date 2026-10-17 --price
  python3 tools/experiments/cost/cloudwatch_usage.py --start 2026-10-17T06:00Z --end 2026-10-17T18:00Z
  python3 tools/experiments/cost/cloudwatch_usage.py --stacks seatrelay-app-dev seatrelay-auth --cli

The window defaults to the whole UTC day of --date (default 2026-10-17) and is cut at the current time
(rounded down to --period) when the day is not over yet. Pricing keys produced: http_api_request,
lambda_request_arm, lambda_gbs_arm, sqs_request_fifo, sqs_request_standard, ddb_rru_ondemand,
ddb_wru_ondemand, ddb_streams_rru (0, see the .md), cw_logs_ingest_gb, eventbridge_scheduler_invocation,
ses_email_<plan>, cloudfront_https_request_asia, cloudfront_dto_gb_asia, cognito_mau_<tier>,
data_transfer_out_gb. Month-level fixed items (custom metrics, alarms, dashboard) and storage are not
day usage and are left out; "registrations" is left out because no metric counts REGISTER commands.

AWS access is read-only: cloudformation describe-stacks / list-stacks / list-stack-resources, lambda
get-function-configuration / get-event-source-mapping, dynamodb describe-table, scheduler
list-schedules, sesv2 get-account, ses get-send-statistics, cognito-idp describe-user-pool / list-users and cloudwatch
get-metric-data (ap-southeast-1; CloudFront metrics live in us-east-1). GetMetricData is billed at
US$0.01 per 1,000 metrics requested (about 120 metrics per run).

Dependencies: Python 3.9+; boto3 when importable, otherwise the aws CLI through subprocess (--cli
forces the CLI). model.py (only with --price) needs pandas and matplotlib.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
GIB = 1024 ** 3  # model.py converts KB -> GB with /1024/1024, i.e. GiB; AWS bills data in GiB
DEFAULT_STACKS = ["seatrelay-app-dev", "seatrelay-app-pilot", "seatrelay-web-dev", "seatrelay-web-pilot", "seatrelay-auth"]
CLOUDFRONT_REGION = "us-east-1"

# ----------------------------------------------------------------------------- AWS access


class AwsError(RuntimeError):
    pass


def snake(op: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", op).lower()


def iso(value) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raise TypeError(f"not JSON serialisable: {value!r}")


class Aws:
    """Read-only AWS calls through boto3 when importable, else the aws CLI (same request/response shapes)."""

    def __init__(self, force_cli: bool = False):
        self.boto3 = None
        if not force_cli:
            try:
                import boto3  # noqa: F401  (optional)

                self.boto3 = boto3
            except ImportError:
                pass
        if self.boto3 is None and shutil.which("aws") is None:
            sys.exit("neither boto3 nor the aws CLI is available")
        self.backend = "boto3" if self.boto3 else "aws CLI"
        self.clients: dict = {}
        self.calls: Counter = Counter()

    def call(self, service: str, op: str, region: str, **params) -> dict:
        self.calls[f"{service} {snake(op).replace('_', '-')}"] += 1
        if self.boto3 is not None:
            client = self.clients.get((service, region))
            if client is None:
                client = self.clients[(service, region)] = self.boto3.client(service, region_name=region)
            try:
                return getattr(client, snake(op))(**params)
            except Exception as exc:  # botocore ClientError / ParamValidationError
                raise AwsError(str(exc)) from exc
        cmd = ["aws", service, snake(op).replace("_", "-"), "--region", region, "--output", "json",
               "--no-paginate", "--cli-input-json", json.dumps(params, default=iso)]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            raise AwsError(out.stderr.strip())
        return json.loads(out.stdout or "{}")

    def pages(self, service: str, op: str, region: str, token_in: str, token_out: str, **params):
        while True:
            resp = self.call(service, op, region, **params)
            yield resp
            token = resp.get(token_out)
            if not token:
                return
            params[token_in] = token


def to_dt(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    return parse_time(str(value))


def parse_time(text: str) -> datetime:
    t = text.strip().replace("Z", "+00:00")
    if len(t) == 10:
        t += "T00:00:00+00:00"
    dt = datetime.fromisoformat(t)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ----------------------------------------------------------------------------- metrics


@dataclass(frozen=True)
class Metric:
    namespace: str
    name: str
    dims: tuple[tuple[str, str], ...]
    stat: str = "Sum"
    region: str = ""


@dataclass
class MetricReader:
    """Batches GetMetricData queries per region and sums the datapoints over the window."""

    aws: Aws
    start: datetime
    end: datetime
    period: int
    wanted: dict = field(default_factory=dict)  # Metric -> None until fetched, then (sum, points)
    requested: int = 0

    def get(self, m: Metric) -> tuple[float, int]:
        if m not in self.wanted or self.wanted[m] is None:
            self.fetch([m])
        return self.wanted[m]

    def value(self, m: Metric) -> float:
        return self.get(m)[0]

    def fetch(self, metrics: list[Metric]):
        todo = [m for m in dict.fromkeys(metrics) if self.wanted.get(m) is None]
        by_region: dict[str, list[Metric]] = defaultdict(list)
        for m in todo:
            by_region[m.region].append(m)
        for region, ms in by_region.items():
            for i in range(0, len(ms), 100):
                chunk = ms[i:i + 100]
                queries = [{
                    "Id": f"m{j}",
                    "MetricStat": {
                        "Metric": {"Namespace": m.namespace, "MetricName": m.name,
                                   "Dimensions": [{"Name": k, "Value": v} for k, v in m.dims]},
                        "Period": self.period, "Stat": m.stat},
                    "ReturnData": True,
                } for j, m in enumerate(chunk)]
                self.requested += len(queries)
                start, end = self.start, self.end
                if self.aws.boto3 is None:  # the CLI wants strings
                    start, end = iso(start), iso(end)
                sums: dict[str, float] = defaultdict(float)
                points: Counter = Counter()
                for resp in self.aws.pages("cloudwatch", "GetMetricData", region, "NextToken", "NextToken",
                                           MetricDataQueries=queries, StartTime=start, EndTime=end,
                                           ScanBy="TimestampAscending"):
                    for r in resp.get("MetricDataResults", []):
                        sums[r["Id"]] += float(sum(r.get("Values", [])))
                        points[r["Id"]] += len(r.get("Values", []))
                for j, m in enumerate(chunk):
                    self.wanted[m] = (sums.get(f"m{j}", 0.0), points.get(f"m{j}", 0))


# ----------------------------------------------------------------------------- discovery


@dataclass
class Resources:
    stacks: dict = field(default_factory=dict)  # stack -> status / None
    deleted: list = field(default_factory=list)  # (name, created, deleted) overlapping the window
    by_type: dict = field(default_factory=lambda: defaultdict(list))  # type -> [(stack, logical, physical)]
    notes: list = field(default_factory=list)


def discover(aws: Aws, region: str, stacks: list[str], start: datetime, end: datetime) -> Resources:
    res = Resources()
    for name in stacks:
        try:
            st = aws.call("cloudformation", "DescribeStacks", region, StackName=name)["Stacks"][0]
            res.stacks[name] = st["StackStatus"]
        except AwsError as exc:
            res.stacks[name] = None
            res.notes.append(f"stack {name} not found ({str(exc).splitlines()[-1][:120]}); skipped")
            continue
        for page in aws.pages("cloudformation", "ListStackResources", region, "NextToken", "NextToken", StackName=name):
            for r in page.get("StackResourceSummaries", []):
                if r.get("PhysicalResourceId"):
                    res.by_type[r["ResourceType"]].append((name, r["LogicalResourceId"], r["PhysicalResourceId"]))
    try:
        for page in aws.pages("cloudformation", "ListStacks", region, "NextToken", "NextToken",
                              StackStatusFilter=["DELETE_COMPLETE"]):
            for s in page.get("StackSummaries", []):
                created, deleted = to_dt(s.get("CreationTime")), to_dt(s.get("DeletionTime"))
                if s["StackName"] in stacks and deleted and deleted > start and created and created < end:
                    res.deleted.append((s["StackName"], created, deleted))
    except AwsError as exc:
        res.notes.append(f"list-stacks failed ({exc}); deleted stacks not checked")
    return res


def queue_name(url_or_arn: str) -> str:
    return url_or_arn.rstrip("/").split("/")[-1].split(":")[-1]


# ----------------------------------------------------------------------------- formatting


def fmt(v: float, digits: int = 2) -> str:
    if v is None:
        return ""
    if v == 0:
        return "0"
    if float(v).is_integer() or abs(v) >= 1000:
        return f"{v:,.0f}"
    if abs(v) >= 1:
        return f"{v:,.{digits}f}"
    return f"{v:.4g}"


def table(header: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        out.append("| " + " | ".join("" if c is None else str(c) for c in r) + " |")
    return "\n".join(out)


# ----------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default="2026-10-17", help="UTC day to measure (default 2026-10-17); sets --start/--end")
    ap.add_argument("--start", help="window start, ISO 8601 (UTC if no offset); overrides --date")
    ap.add_argument("--end", help="window end, ISO 8601; cut at the current time")
    ap.add_argument("--period", type=int, default=300, help="GetMetricData period in seconds (multiple of 60)")
    ap.add_argument("--region", default="ap-southeast-1", help="region of the stacks")
    ap.add_argument("--stacks", nargs="+", default=DEFAULT_STACKS, help="CloudFormation stacks to measure")
    ap.add_argument("--out", type=Path, default=REPO / "results" / "cost", help="output directory")
    ap.add_argument("--price", action="store_true", help="also run model.py --usage (in a temporary --out) and copy the priced table")
    ap.add_argument("--cli", action="store_true", help="use the aws CLI even when boto3 is importable")
    args = ap.parse_args()
    if args.period % 60:
        sys.exit("--period must be a multiple of 60")

    day = date.fromisoformat(args.date)
    start = parse_time(args.start) if args.start else datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    requested_end = parse_time(args.end) if args.end else start + timedelta(days=1)
    now = datetime.now(timezone.utc)
    floor = lambda t: datetime.fromtimestamp(int(t.timestamp()) // args.period * args.period, timezone.utc)  # noqa: E731
    start = floor(start)
    end = min(requested_end, floor(now))
    if end <= start:
        sys.exit(f"empty window: {iso(start)} .. {iso(end)}")
    partial = end < requested_end
    label = start.strftime("%Y-%m-%d")
    hours = (end - start).total_seconds() / 3600

    aws = Aws(force_cli=args.cli)
    region = args.region
    reader = MetricReader(aws, start, end, args.period)
    M = lambda ns, name, dims=(), stat="Sum", reg=None: Metric(ns, name, tuple(dims), stat, reg or region)  # noqa: E731

    res = discover(aws, region, args.stacks, start, end)
    prices = json.loads((HERE / "pricing.json").read_text())["prices"]
    usage: dict[str, float] = {}
    assumptions: list[str] = []
    notes: list[str] = list(res.notes)
    L: list[str] = []  # markdown body sections

    # ---- Lambda functions, event source mappings, schedules
    functions = []
    for stack, logical, name in res.by_type["AWS::Lambda::Function"]:
        cfg = aws.call("lambda", "GetFunctionConfiguration", region, FunctionName=name)
        functions.append({"stack": stack, "name": name, "mem": int(cfg["MemorySize"]),
                          "arch": (cfg.get("Architectures") or ["x86_64"])[0],
                          "log_group": (cfg.get("LoggingConfig") or {}).get("LogGroup") or f"/aws/lambda/{name}"})
    esms = []
    for stack, logical, uuid in res.by_type["AWS::Lambda::EventSourceMapping"]:
        m = aws.call("lambda", "GetEventSourceMapping", region, UUID=uuid)
        esms.append({"stack": stack, "function": m["FunctionArn"].split(":")[-1], "source": m["EventSourceArn"],
                     "batch": int(m.get("BatchSize") or 0), "window_s": int(m.get("MaximumBatchingWindowInSeconds") or 0)})

    reader.fetch([M("AWS/Lambda", n, [("FunctionName", f["name"])]) for f in functions for n in ("Invocations", "Duration")])
    req_arm = gbs_arm = gbs_x86 = rounding_gbs = 0.0
    rows = []
    for f in functions:
        inv = reader.value(M("AWS/Lambda", "Invocations", [("FunctionName", f["name"])]))
        dur = reader.value(M("AWS/Lambda", "Duration", [("FunctionName", f["name"])]))
        gbs = dur / 1000.0 * f["mem"] / 1024.0
        f.update(inv=inv, dur=dur, gbs=gbs)
        rounding_gbs += inv * 0.001 * f["mem"] / 1024.0
        if f["arch"] == "arm64":
            req_arm += inv
            gbs_arm += gbs
            keys = "lambda_request_arm, lambda_gbs_arm"
        else:
            req_arm += inv  # x86 requests are priced like arm64 (US$0.20/M, pricing.json lambda_request_arm notes)
            gbs_x86 += gbs
            keys = "lambda_request_arm, lambda_gbs_x86" if "lambda_gbs_x86" in prices else "lambda_request_arm, lambda_gbs_arm (x86 under-priced, see notes)"
        rows.append([f["stack"], f["name"], f["arch"], f["mem"], fmt(inv), fmt(dur), fmt(gbs), keys])
    usage["lambda_request_arm"] = req_arm
    if gbs_x86 and "lambda_gbs_x86" in prices:
        usage["lambda_gbs_x86"] = gbs_x86
        usage["lambda_gbs_arm"] = gbs_arm
    else:
        usage["lambda_gbs_arm"] = gbs_arm + gbs_x86
        if gbs_x86:
            notes.append(f"{fmt(gbs_x86)} GB-s ran on x86_64 and are priced at the arm64 rate (pricing.json has no lambda_gbs_x86 key; "
                         "the Price List detail of lambda_gbs_arm gives x86 at US$0.0000166667, 25% more): add a cited key to price them exactly.")
    acct_inv = reader.value(M("AWS/Lambda", "Invocations"))
    archs = sorted({f["arch"] for f in functions})
    L.append("## Lambda (AWS/Lambda, dimension FunctionName)\n")
    L.append(table(["stack", "function", "architecture", "memory MB", "Invocations (Sum)", "Duration ms (Sum)", "GB-s", "pricing keys"], rows))
    L.append(f"\nConversion: requests = Invocations; GB-s = Duration_ms / 1000 x MemorySize / 1024 (MemorySize and "
             f"Architectures from get-function-configuration now; architectures found: {', '.join(archs) or 'none'}). "
             f"Totals: **{fmt(req_arm)} requests -> lambda_request_arm**, **{fmt(gbs_arm + gbs_x86)} GB-s -> "
             f"{'lambda_gbs_arm' if not gbs_x86 else 'see notes'}**.\n")
    L.append(f"Cross-check: account-level AWS/Lambda Invocations (no dimension) = {fmt(acct_inv)} "
             f"({'equal to' if abs(acct_inv - req_arm) < 0.5 else 'differs from'} the per-function sum {fmt(req_arm)}).\n")
    L.append(f"Uncertainty: billed duration is rounded up to the next 1 ms per invocation (at most +{fmt(rounding_gbs)} GB-s here). "
             "Since 2025-08-01 Lambda also bills the INIT phase of on-demand functions on managed runtimes; the Duration metric "
             "excludes it and cold-start counts are only in the REPORT log lines (not read here), so lambda_gbs_arm is a lower bound "
             "by roughly (cold starts x 0.2-0.6 s x MemorySize/1024).\n")

    # ---- HTTP API
    apis = [(s, p) for s, _, p in res.by_type["AWS::ApiGatewayV2::Api"]]
    reader.fetch([M("AWS/ApiGateway", n, [("ApiId", a)]) for _, a in apis for n in ("Count", "4xx", "5xx", "DataProcessed")])
    rows, api_count, api_4xx, api_bytes = [], 0.0, 0.0, 0.0
    for stack, api in apis:
        c, e4, e5, b = (reader.value(M("AWS/ApiGateway", n, [("ApiId", api)])) for n in ("Count", "4xx", "5xx", "DataProcessed"))
        api_count += c
        api_4xx += e4
        api_bytes += b
        rows.append([stack, api, fmt(c), fmt(e4), fmt(e5), fmt(b), "http_api_request"])
    usage["http_api_request"] = api_count
    usage["data_transfer_out_gb"] = api_bytes / GIB
    acct_count = reader.value(M("AWS/ApiGateway", "Count"))
    L.append("## HTTP API (AWS/ApiGateway, dimension ApiId)\n")
    L.append(table(["stack", "ApiId", "Count", "4xx", "5xx", "DataProcessed bytes", "pricing key"], rows))
    L.append(f"\nConversion: http_api_request = sum of Count = **{fmt(api_count)}**. Count includes 4xx responses "
             f"({fmt(api_4xx)}); the API Gateway pricing page states that requests failing authorization are not charged (not "
             f"re-verified in this session), so the billable count lies between {fmt(api_count - api_4xx)} and {fmt(api_count)} (Count is used). "
             f"data_transfer_out_gb = DataProcessed / 2^30 = **{fmt(api_bytes / GIB)} GB**, an upper bound on data transfer out "
             "(DataProcessed counts request and response bytes). "
             f"Cross-check: account-level Count (no dimension) = {fmt(acct_count)}.\n")

    # ---- SQS
    queues = [(s, queue_name(p)) for s, _, p in res.by_type["AWS::SQS::Queue"]]
    consumer = {}  # queue name -> esm
    for e in esms:
        if ":sqs:" in e["source"]:
            consumer[queue_name(e["source"])] = e
    inv_of = {f["name"]: f["inv"] for f in functions}
    sqs_metrics = ("NumberOfMessagesSent", "NumberOfMessagesReceived", "NumberOfMessagesDeleted", "NumberOfEmptyReceives")
    reader.fetch([M("AWS/SQS", n, [("QueueName", q)]) for _, q in queues
                  for n in sqs_metrics + (("NumberOfDeduplicatedSentMessages",) if q.endswith(".fifo") else ())])
    sends_batched_queues: set[str] = set()
    src_sqs = (REPO / "services" / "aws" / "src" / "adapters" / "sqs.ts")
    send_batch_in_code = src_sqs.exists() and "SendMessageBatchCommand" in src_sqs.read_text()
    if send_batch_in_code:  # SqsTimerScheduler batches the timers of one commit onto the delay queue
        sends_batched_queues = {q for _, q in queues if q.endswith("-expiry-delay")}
    rows = []
    totals = {"fifo": [0.0, 0.0, 0.0], "standard": [0.0, 0.0, 0.0]}
    for stack, q in queues:
        kind = "fifo" if q.endswith(".fifo") else "standard"
        s, r, d, e = (reader.value(M("AWS/SQS", n, [("QueueName", q)])) for n in sqs_metrics)
        dup = reader.value(M("AWS/SQS", "NumberOfDeduplicatedSentMessages", [("QueueName", q)])) if kind == "fifo" else 0.0
        esm = consumer.get(q)
        # sends: one SendMessage per message, except SendMessageBatch (<= 10 per call) on the delay queue
        send_lo = math.ceil(s / 10) if q in sends_batched_queues else s
        # NumberOfMessagesSent already counts deduplicated FIFO sends (Sent - Deduplicated = Deleted on
        # the drained commands queue), so Deduplicated is reported, not added.
        send_mid, send_hi = s, s
        if esm:
            inv = inv_of.get(esm["function"], 0.0)
            recv_lo, recv_hi = math.ceil(r / 10), r
            recv_mid = min(max(inv, recv_lo), recv_hi)
            del_lo, del_hi = math.ceil(d / 10), d
            del_mid = min(max(inv, del_lo), del_hi)
            who = f"{esm['function']} (BatchSize {esm['batch']}, {fmt(inv)} invocations)"
        else:
            recv_lo = recv_mid = recv_hi = r
            del_lo = del_mid = del_hi = d
            who = "none"
        lo, mid, hi = send_lo + e + recv_lo + del_lo, send_mid + e + recv_mid + del_mid, send_hi + e + recv_hi + del_hi
        for i, v in enumerate((lo, mid, hi)):
            totals[kind][i] += v
        rows.append([stack, q, kind, fmt(s), fmt(dup) if kind == "fifo" else "-", fmt(r), fmt(d), fmt(e), who,
                     f"{fmt(lo)} / **{fmt(mid)}** / {fmt(hi)}", f"sqs_request_{kind}"])
    usage["sqs_request_fifo"] = totals["fifo"][1]
    usage["sqs_request_standard"] = totals["standard"][1]
    L.append("## SQS (AWS/SQS, dimension QueueName)\n")
    L.append(table(["stack", "queue", "type", "Sent", "Deduplicated", "Received", "Deleted", "EmptyReceives", "consumer",
                    "requests low / **central** / high", "pricing key"], rows))
    L.append("\nSQS bills API requests (each Send/Receive/Delete/ChangeVisibility call, per 64 KB chunk; every SeatRelay "
             "message is far below 64 KB), not messages. Per queue:\n")
    L.append("```\nrequests = sends + EmptyReceives + receive_calls + delete_calls\n"
             "  sends         = Sent                  (one SendMessage per message: api intake, forwarder, sweep;\n"
             "                                         SendMessageBatch of <= 10 timers per commit on *-expiry-delay -> low = ceil(Sent/10))\n"
             "  EmptyReceives = NumberOfEmptyReceives (exact: each is one ReceiveMessage call that returned nothing)\n"
             "  receive_calls = consumer Lambda invocations (one ReceiveMessage per batch), bounded to [ceil(Received/10), Received]\n"
             "  delete_calls  = consumer Lambda invocations (one DeleteMessageBatch per batch), bounded to [ceil(Deleted/10), Deleted]\n"
             "  (queues without a consumer: receive_calls = Received, delete_calls = Deleted)\n```\n")
    L.append(f"Totals (low / **central** / high): FIFO {fmt(totals['fifo'][0])} / **{fmt(totals['fifo'][1])}** / {fmt(totals['fifo'][2])} "
             f"-> sqs_request_fifo; standard {fmt(totals['standard'][0])} / **{fmt(totals['standard'][1])}** / {fmt(totals['standard'][2])} "
             "-> sqs_request_standard. The JSON uses the central values.\n")
    L.append("Uncertainty: (1) one ReceiveMessage per Lambda batch is the event-source-mapping behaviour assumed for the central "
             "value; the pollers may fetch up to 10 messages per call and split them into BatchSize-1 invocations (fewer calls) or "
             "issue extra calls (more), hence the bounds; (2) NumberOfMessagesSent already includes deduplicated FIFO sends: on the "
             "drained commands queue Sent - Deduplicated equals Deleted, so the Deduplicated column is shown but not added; (3) calls that CloudWatch does not "
             "count are missing: GetQueueAttributes/PurgeQueue from the experiment scripts and the console, and the poller's "
             "ChangeMessageVisibility calls, if any. Messages moved to a DLQ by a redrive policy are not counted in Sent.\n"
             + (f"SendMessageBatch found in services/aws/src/adapters/sqs.ts (SqsTimerScheduler, delay queue only); "
                "SendMessage is used for commands.fifo (SqsCommandQueue, sweep, forwarder) and for re-delays.\n" if send_batch_in_code else ""))

    # ---- DynamoDB
    rows, rru, wru = [], 0.0, 0.0
    stream_consumers = defaultdict(list)
    for e in esms:
        if ":dynamodb:" in e["source"]:
            stream_consumers[e["source"].split("/")[1]].append(e["function"])
    table_sizes, targets = [], []
    for stack, _, t in res.by_type["AWS::DynamoDB::Table"]:
        d = aws.call("dynamodb", "DescribeTable", region, TableName=t)["Table"]
        mode = (d.get("BillingModeSummary") or {}).get("BillingMode", "PROVISIONED")
        if mode != "PAY_PER_REQUEST":
            notes.append(f"table {t} is {mode}: its consumed units are not on-demand request units; priced as on-demand anyway (check).")
        table_sizes.append((t, d.get("TableSizeBytes", 0), d.get("ItemCount", 0)))
        targets += [(stack, t, None, mode)] + [(stack, t, g["IndexName"], mode) for g in d.get("GlobalSecondaryIndexes", [])]
    ddb_dims = lambda t, gsi: [("TableName", t)] + ([("GlobalSecondaryIndexName", gsi)] if gsi else [])  # noqa: E731
    reader.fetch([M("AWS/DynamoDB", n, ddb_dims(t, g)) for _, t, g, _ in targets
                  for n in ("ConsumedReadCapacityUnits", "ConsumedWriteCapacityUnits")])
    for stack, t, gsi, mode in targets:
        r_ = reader.value(M("AWS/DynamoDB", "ConsumedReadCapacityUnits", ddb_dims(t, gsi)))
        w_ = reader.value(M("AWS/DynamoDB", "ConsumedWriteCapacityUnits", ddb_dims(t, gsi)))
        rru += r_
        wru += w_
        rows.append([stack, t + (f" / {gsi}" if gsi else ""), mode, fmt(r_), fmt(w_), "ddb_rru_ondemand, ddb_wru_ondemand"])
    usage["ddb_rru_ondemand"] = rru
    usage["ddb_wru_ondemand"] = wru
    usage["ddb_streams_rru"] = 0.0
    L.append("## DynamoDB (AWS/DynamoDB, dimensions TableName and TableName + GlobalSecondaryIndexName)\n")
    L.append(table(["stack", "table / GSI", "billing mode", "ConsumedReadCapacityUnits (Sum)", "ConsumedWriteCapacityUnits (Sum)", "pricing keys"], rows))
    sc = "; ".join(f"{t}: {', '.join(fns)}" for t, fns in stream_consumers.items()) or "none"
    L.append(f"\nConversion: on-demand tables bill one RRU/WRU per consumed read/write capacity unit, so ddb_rru_ondemand = "
             f"**{fmt(rru)}** and ddb_wru_ondemand = **{fmt(wru)}** (table + GSI rows; the metrics already include the x2 of "
             "transactional requests and the 0.5 of eventually consistent reads; TTL deletes are free and not counted). "
             f"ddb_streams_rru = **0**: the only stream consumers are Lambda event-source mappings ({sc}), and GetRecords calls made "
             "by Lambda triggers are not charged (pricing.json ddb_streams_rru notes and docs/COST.md section 3; model.py prices "
             "them only with --charge-stream-reads).\n")

    # ---- CloudWatch Logs ingestion
    groups = {p: s for s, _, p in res.by_type["AWS::Logs::LogGroup"]}
    for f in functions:
        groups.setdefault(f["log_group"], f["stack"])
    reader.fetch([M("AWS/Logs", "IncomingBytes", [("LogGroupName", g)]) for g in groups])
    rows, log_bytes = [], 0.0
    for g, stack in sorted(groups.items()):
        b = reader.value(M("AWS/Logs", "IncomingBytes", [("LogGroupName", g)]))
        log_bytes += b
        rows.append([stack, g, fmt(b), fmt(b / GIB), "cw_logs_ingest_gb"])
    usage["cw_logs_ingest_gb"] = log_bytes / GIB
    L.append("## CloudWatch Logs ingestion (AWS/Logs IncomingBytes, dimension LogGroupName)\n")
    L.append(table(["stack", "log group", "IncomingBytes (Sum)", "GB", "pricing key"], rows))
    L.append(f"\nConversion: cw_logs_ingest_gb = sum of IncomingBytes / 2^30 = **{fmt(log_bytes / GIB)} GB** (uncompressed bytes, "
             "the basis of the ingestion charge; Lambda function logs are billed as vended logs whose first volume tier has the "
             "same price as the Standard class).\n")

    # ---- EventBridge Scheduler (sweep)
    sched = [(s, p) for s, _, p in res.by_type["AWS::Scheduler::Schedule"]]
    sweep_fns = [f for f in functions if f["name"].endswith("-sweep")]
    sweep_inv = sum(f["inv"] for f in sweep_fns)
    group_names = Counter()
    foreign = []
    try:
        for page in aws.pages("scheduler", "ListSchedules", region, "NextToken", "NextToken"):
            for s in page.get("Schedules", []):
                group_names[s.get("GroupName", "default")] += 1
                if not s["Name"].startswith("seatrelay-"):
                    foreign.append(s["Name"])
    except AwsError as exc:
        notes.append(f"scheduler list-schedules failed ({exc}); schedule groups not checked")
    attempts = None
    if group_names and not foreign:
        attempts = sum(reader.value(M("AWS/Scheduler", "InvocationAttemptCount", [("ScheduleGroup", g)])) for g in group_names)
    sweep_src = "AWS/Scheduler InvocationAttemptCount" if attempts else "sweep Lambda Invocations"
    usage["eventbridge_scheduler_invocation"] = attempts if attempts else sweep_inv
    L.append("## EventBridge Scheduler (sweep schedules)\n")
    L.append(table(["stack", "schedule", "group(s) in account", "InvocationAttemptCount (group Sum)", "sweep Lambda Invocations", "pricing key"],
                   [[s, p, ", ".join(f"{g} ({n} schedules)" for g, n in group_names.items()), fmt(attempts) if attempts is not None else "n/a",
                     fmt(sum(f['inv'] for f in sweep_fns if f['stack'] == s)), "eventbridge_scheduler_invocation"] for s, p in sched]))
    L.append(f"\nInvocationAttemptCount is published per schedule group, not per schedule; "
             f"{'every schedule in the account is a SeatRelay sweep, so the group total is used' if not foreign else 'the group also holds non-SeatRelay schedules (' + ', '.join(foreign) + '), so the sweep Lambda invocations are used instead'}"
             f": eventbridge_scheduler_invocation = **{fmt(usage['eventbridge_scheduler_invocation'])}** ({sweep_src}; "
             f"sweep Lambda invocations {fmt(sweep_inv)}, rate(5 minutes) = 12/h per stage). All of it is inside the 14M/month free allowance.\n")

    # ---- SES
    ses_send = reader.value(M("AWS/SES", "Send"))
    plan, sandbox = None, None
    try:
        acct = aws.call("sesv2", "GetAccount", region)
        plan = ((acct.get("PricingAttributes") or {}).get("CurrentPlan") or "").upper() or None
        sandbox = not acct.get("ProductionAccessEnabled", False)
    except AwsError as exc:
        notes.append(f"sesv2 get-account failed ({exc}); SES plan assumed Essentials")
    ses_key = "ses_email_alacarte" if plan and plan not in ("ESSENTIALS",) else "ses_email_essentials"
    usage[ses_key] = ses_send
    ses_v1 = None
    try:
        pts = aws.call("ses", "GetSendStatistics", region).get("SendDataPoints", [])
        ses_v1 = sum(p.get("DeliveryAttempts", 0) for p in pts if start <= to_dt(p["Timestamp"]) < end)
    except AwsError as exc:
        notes.append(f"ses get-send-statistics failed ({str(exc)[:80]})")
    one_rcpt = (REPO / "services" / "aws" / "src" / "adapters" / "ses.ts")
    one_rcpt = one_rcpt.exists() and "ToAddresses: [message.to]" in one_rcpt.read_text()
    L.append("## SES (AWS/SES Send, account level)\n")
    L.append(f"Send (Sum over the window, account level, no dimension) = **{fmt(ses_send)}** -> {ses_key}. "
             f"sesv2 get-account: pricing plan {plan or 'not reported'}, "
             f"{'sandbox (production access not granted)' if sandbox else 'production access' if sandbox is not None else 'sandbox state unknown'}. "
             "pricing.json/docs/COST.md price accounts that started sending after 2026-07-21 on the Essentials plan "
             "(US$0.16 per 1,000); the account reports that plan. The metric is account-wide (the account runs no other "
             "SES workload). SES bills per recipient; "
             + ("services/aws/src/adapters/ses.ts sends one recipient per message (`ToAddresses: [message.to]`), so Send = e-mails billed. "
                if one_rcpt else "one recipient per message is assumed. ")
             + (f"Cross-check: ses get-send-statistics reports {fmt(ses_v1)} delivery attempts in the window"
                + (" (it disagrees with the metric; the CloudWatch Send/Delivery metrics are used)" if ses_v1 != ses_send else "")
                + ".\n" if ses_v1 is not None else "\n"))

    # ---- CloudFront
    dists = [(s, p) for s, _, p in res.by_type["AWS::CloudFront::Distribution"]]
    cf = lambda n, d: M("AWS/CloudFront", n, [("DistributionId", d), ("Region", "Global")], reg=CLOUDFRONT_REGION)  # noqa: E731
    reader.fetch([cf(n, d) for _, d in dists for n in ("Requests", "BytesDownloaded")])
    rows, cf_req, cf_bytes = [], 0.0, 0.0
    for stack, d in dists:
        rq, by = reader.value(cf("Requests", d)), reader.value(cf("BytesDownloaded", d))
        cf_req += rq
        cf_bytes += by
        rows.append([stack, d, fmt(rq), fmt(by), fmt(by / GIB), "cloudfront_https_request_asia, cloudfront_dto_gb_asia"])
    usage["cloudfront_https_request_asia"] = cf_req
    usage["cloudfront_dto_gb_asia"] = cf_bytes / GIB
    L.append("## CloudFront (AWS/CloudFront in us-east-1, dimensions DistributionId + Region=Global)\n")
    L.append(table(["stack", "distribution", "Requests (Sum)", "BytesDownloaded (Sum)", "GB", "pricing keys"], rows))
    L.append(f"\nConversion: cloudfront_https_request_asia = Requests = **{fmt(cf_req)}**; cloudfront_dto_gb_asia = BytesDownloaded / 2^30 = "
             f"**{fmt(cf_bytes / GIB)} GB**. All requests are priced as HTTPS at the Asia Pacific edge rate (the distributions redirect "
             "HTTP to HTTPS, PriceClass_200, viewers in Singapore); requests served by US/EU edges would be cheaper, so this is an "
             "upper bound. The metric does not split by edge location.\n")

    # ---- Cognito
    rows = []
    for stack, _, pool in res.by_type["AWS::Cognito::UserPool"]:
        d = aws.call("cognito-idp", "DescribeUserPool", region, UserPoolId=pool)["UserPool"]
        tier = (d.get("UserPoolTier") or "ESSENTIALS").upper()
        users, created_month = 0, 0
        month_start = datetime(start.year, start.month, 1, tzinfo=timezone.utc)
        try:
            for page in aws.pages("cognito-idp", "ListUsers", region, "PaginationToken", "PaginationToken",
                                  UserPoolId=pool, AttributesToGet=[], Limit=60):
                for u in page.get("Users", []):
                    users += 1
                    c = to_dt(u.get("UserCreateDate"))
                    created_month += bool(c and c >= month_start)
            src = "list-users"
        except AwsError as exc:
            users, created_month, src = int(d.get("EstimatedNumberOfUsers", 0)), None, "describe-user-pool EstimatedNumberOfUsers"
            notes.append(f"cognito list-users failed ({str(exc)[:80]}); used EstimatedNumberOfUsers")
        key = {"ESSENTIALS": "cognito_mau_essentials", "LITE": "cognito_mau_lite"}.get(tier)
        if key is None:
            notes.append(f"user pool {pool} is on the {tier} tier, which pricing.json does not price; its MAU are left out")
        else:
            usage[key] = usage.get(key, 0.0) + users
        rows.append([stack, pool, tier, users, created_month if created_month is not None else "n/a", src, key or "(not priced)"])
    L.append("## Cognito user pool\n")
    L.append(table(["stack", "user pool", "tier", "users in pool", f"created since {start:%Y-%m-01}", "source", "pricing key"], rows))
    L.append("\nCognito bills monthly active users (a user with an authentication event in the calendar month), which no metric "
             "reports per user. The number of users in the pool is an **upper bound on the month's MAU** (a user who did not "
             "sign in, sign up or refresh a token during the month is not an MAU). It is a month-level quantity: pricing it "
             "next to one day of usage puts the whole month's MAU charge into the day (list price; the 10,000 free MAU of the "
             "Essentials tier cover it after free tier).\n")

    # ---- context: SeatRelay custom metrics (not billed per day; activity only)
    ctx_rows = []
    for stage in sorted({f["name"].split("-")[1] for f in functions if f["name"].startswith("seatrelay-")}):
        dims = [("stage", stage), ("service", "worker")]
        settled = reader.value(M("SeatRelay", "CommandSettledLatency", dims, "SampleCount"))
        offers = reader.value(M("SeatRelay", "OffersCreated", dims))
        ctx_rows.append([stage, fmt(settled), fmt(offers)])
    L.append("## Activity context (SeatRelay custom metrics, not priced)\n")
    L.append(table(["stage", "commands settled (CommandSettledLatency SampleCount)", "offers created (OffersCreated Sum)"], ctx_rows))
    L.append("\nThese count all command types (REGISTER, ACCEPT, DECLINE, CANCEL, TICK, admin commands) and offers; no metric "
             "counts REGISTER commands, so the usage object has no `registrations` entry and model.py reports no unit cost.\n")

    # ---- excluded items
    n_alarms = len(res.by_type["AWS::CloudWatch::Alarm"])
    n_dash = len(res.by_type["AWS::CloudWatch::Dashboard"])
    sizes = ", ".join(f"{t} {fmt(b / 1024 / 1024)} MB / {n:,} items" for t, b, n in table_sizes) or "n/a"
    excluded = [
        f"Fixed monthly items: CloudWatch alarms ({n_alarms} in these stacks), dashboards ({n_dash}) and custom metrics "
        "(SeatRelay namespace, EMF) are billed per month, not per day; they are already fixed costs in model.py "
        "(cw_alarm_month, cw_dashboard_month, cw_custom_metric_month) and are left out of the day's usage.",
        f"Storage (ddb_storage_gb_month, ddb_pitr_gb_month, s3_storage_gb_month, cw_logs_storage_gb_month) is metered in "
        f"GB-month over time, not by the day's activity; table sizes now (describe-table, updated about every 6 h): {sizes}. "
        "One day's share is far below US$0.01.",
        "X-Ray traces (xray_trace_recorded/retrieved), S3 requests (CloudFront misses and deployments; S3 request metrics are "
        "not enabled), CloudWatch API requests (dashboards, experiment scripts and this script's GetMetricData), SNS alarm "
        "notifications and Budgets are not available as AWS/* metrics without extra configuration and are left out "
        "(all are inside their free allowances at this volume except GetMetricData, about US$0.001 per run of this script).",
        "registrations: no metric counts REGISTER commands; the key is omitted, so model.py prints no unit cost.",
    ]

    # ---- write the usage object
    args.out.mkdir(parents=True, exist_ok=True)
    unknown = [k for k in usage if k not in prices]
    if unknown:
        notes.append("keys not in pricing.json (model.py ignores them): " + ", ".join(unknown))
    usage_out = {k: round(v, 9) for k, v in usage.items()}
    jpath = args.out / f"usage-{label}-cloudwatch.json"
    jpath.write_text(json.dumps(usage_out, indent=2) + "\n")

    # ---- optional pricing through model.py (temporary --out so committed outputs are untouched)
    priced_note = None
    if args.price:
        rel_json = jpath.relative_to(REPO) if jpath.is_relative_to(REPO) else jpath
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [sys.executable, str(HERE / "model.py"), "--usage", str(rel_json), "--out", tmp]
            run = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
            if run.returncode != 0:
                sys.exit(f"model.py failed:\n{run.stderr}")
            priced = Path(tmp) / "usage-priced.md"
            text = priced.read_text()
            for target in (args.out / f"usage-{label}-cloudwatch-priced.md", args.out / "usage-priced.md"):
                target.write_text(text)
        m = re.search(r"List price: \*\*US\$([\d,\.]+)\*\*; after free tier: \*\*US\$([\d,\.]+)\*\*", text)
        cells = [line.split("|")[1:-1] for line in text.splitlines() if line.startswith("| ") and not line.startswith("| key")]
        month_level = sum(float(c[6].replace(",", "")) for c in cells if c[0].strip().startswith("cognito_"))
        no_mau = sum(float(c[6].replace(",", "")) for c in cells) - month_level
        priced_note = (f"Priced with `python3 tools/experiments/cost/model.py --usage {rel_json} --out <temporary dir>`: "
                       f"list price **US${m.group(1)}**, after free tier **US${m.group(2)}**; without the month-level Cognito MAU "
                       f"line (US${month_level:,.4f} list) the window's list price is US${no_mau:,.2f} "
                       f"(table: `usage-{label}-cloudwatch-priced.md`, copied to `usage-priced.md` for report/tools/report_numbers.py). "
                       "The after-free-tier figure applies the full monthly allowances to this window alone.") if m else None

    # ---- markdown
    H = [f"# SeatRelay usage from CloudWatch, {label} (UTC)\n",
         f"Generated by `tools/experiments/cost/cloudwatch_usage.py` ({aws.backend}) at {iso(now)}. "
         f"Window: **{iso(start)} to {iso(end)}** ({hours:.2f} h, period {args.period} s"
         + (f"; cut at the current time, the requested end was {iso(requested_end)}: re-run after the day ends for the full day" if partial else "")
         + "). CloudWatch publishes most AWS/* datapoints 1-5 minutes late (SQS up to 15 minutes), so the last minutes of a "
         "window that ends now can be slightly undercounted.\n",
         "Output: `" + str(jpath.relative_to(REPO) if jpath.is_relative_to(REPO) else jpath) + "` (flat usage object for "
         "`model.py --usage`). Usage quantities are for the window only; model.py prices them with monthly free allowances.\n"]
    if priced_note:
        H.append(priced_note + "\n")
    H.append("## Usage object\n")
    H.append(table(["pricing key", "quantity", "unit", "source"], [
        [k, fmt(v, 4), prices.get(k, {}).get("unit", "?"), {
            "http_api_request": "AWS/ApiGateway Count", "data_transfer_out_gb": "AWS/ApiGateway DataProcessed (upper bound)",
            "lambda_request_arm": "AWS/Lambda Invocations", "lambda_gbs_arm": "AWS/Lambda Duration x MemorySize",
            "sqs_request_fifo": "AWS/SQS, formula below (central)", "sqs_request_standard": "AWS/SQS, formula below (central)",
            "ddb_rru_ondemand": "AWS/DynamoDB ConsumedReadCapacityUnits", "ddb_wru_ondemand": "AWS/DynamoDB ConsumedWriteCapacityUnits",
            "ddb_streams_rru": "0: Lambda trigger reads are free", "cw_logs_ingest_gb": "AWS/Logs IncomingBytes",
            "eventbridge_scheduler_invocation": sweep_src, "cloudfront_https_request_asia": "AWS/CloudFront Requests",
            "cloudfront_dto_gb_asia": "AWS/CloudFront BytesDownloaded",
        }.get(k, "AWS/SES Send" if k.startswith("ses_") else "users in pool (MAU upper bound)" if k.startswith("cognito_") else "")]
        for k, v in usage.items()]))
    H.append("")
    H.append("## Stacks\n")
    H.append(table(["stack", "status"], [[s, st or "not found"] for s, st in res.stacks.items()]))
    if res.deleted:
        complete = abs(acct_inv - req_arm) < 0.5 and abs(acct_count - api_count) < 0.5
        H.append("\nStacks deleted inside the window: " + "; ".join(
            f"{n} (created {iso(c)}, deleted {iso(d)})" for n, c, d in res.deleted)
            + ". Their explicitly named resources (functions, queues, table, log groups) share the names of the current stack, "
            "so their metrics are included; auto-named resources of the deleted stack (e.g. its HTTP API id) are not. "
            + ("The account-level Lambda Invocations and API Gateway Count equal the per-resource sums, so no usage of a "
               "deleted resource is missing from those two." if complete else
               "The account-level Lambda Invocations or API Gateway Count differ from the per-resource sums (see those sections)."))
    H.append("")
    body = [*H, *L, "## Not included\n", *[f"- {x}" for x in excluded], ""]
    body.append("## Assumptions and uncertainty\n")
    assumptions += [
        "Resources are those listed by list-stack-resources for the stacks above now; metrics are summed by resource name, so a "
        "resource that existed earlier in the window under the same name is included.",
        "MemorySize and Architectures are read now and assumed constant over the window (a configuration change during the "
        "day would mis-weight GB-s).",
        "All Lambda functions are arm64, so lambda_request_arm and lambda_gbs_arm are used; an x86_64 function would be "
        "reported in the notes." if archs == ["arm64"] else "Some functions are not arm64: see notes.",
        "GB = 2^30 bytes for logs, CloudFront and API data, consistent with model.py.",
        "HTTP API Count is taken as billable although authorizer rejections and throttled requests (part of 4xx) are not billed.",
        "SQS requests follow the formula in the SQS section; the JSON uses the central estimate, the low/high bounds are shown there.",
        "CloudFront requests and bytes are all priced at the Asia Pacific HTTPS / data-transfer rate (upper bound).",
        "SES Send is account level; the account runs no other SES workload.",
        "Cognito MAU = users in the pool (month-level upper bound), included as asked although it is not a per-day quantity.",
        "model.py applies monthly free-tier allowances to the window's quantities, so the after-free-tier total is the cost of "
        "this window if it were the only usage in its month.",
    ]
    body += [f"- {a}" for a in assumptions]
    if notes:
        body += ["", "## Notes\n", *[f"- {n}" for n in notes]]
    body += ["", "## Calls made\n",
             f"Backend: {aws.backend}. " + ", ".join(f"{k} x{v}" for k, v in sorted(aws.calls.items()))
             + f"; {reader.requested} metrics requested through GetMetricData.", ""]
    mpath = args.out / f"usage-{label}-cloudwatch.md"
    mpath.write_text("\n".join(body))

    print(f"window {iso(start)} .. {iso(end)}{' (partial)' if partial else ''}")
    print(json.dumps(usage_out, indent=2))
    print(f"wrote {jpath}")
    print(f"wrote {mpath}")
    if args.price:
        print(f"wrote {args.out / f'usage-{label}-cloudwatch-priced.md'} and {args.out / 'usage-priced.md'}")
        if priced_note:
            print(priced_note)


if __name__ == "__main__":
    main()
