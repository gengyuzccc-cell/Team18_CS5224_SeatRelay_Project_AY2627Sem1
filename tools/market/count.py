#!/usr/bin/env python3
"""Own counts of the market sizing from the raw captures (docs/market-sizing.md §2, rows 4, 13, 14).

Reads ``results/market/<date>/raw/`` (written by ``capture.py``) and ``tools/market/inputs.json``
(the cited counts), and writes

  results/market/<date>/counts.json   every count and derived quantity, with its basis
  results/market/<date>/summary.md    the same as a readable table

Counting rules (the same as in report/sources.md):

* Library calendars: the union of the events listed on each day of the window (deduplicated by
  event id). An event is a workshop when its category list contains "Workshop". A repeated title
  is a title (trimmed) that occurs on two or more events.
* NTU: the club cards (``<a class="img-card">``) on the special-interest-clubs page; the cards
  after the "Constituent Clubs" heading of the Students' Union Council page (the first card, the
  Union itself, comes before that heading); and the number in "There are <n> Halls of Residence"
  on the clubs-groups-societies page (each hall has its own council).
* Derived: N_clubs = NUS + NTU + SMU + SUTD + SIT; the sensitivity case uses only fetched or own
  counts (NTU + SUTD + SMU 2025); TAM coefficients = N x price, rounded to three significant figures.

Usage:  python3 -I tools/market/count.py [--date 2026-10-17]
"""

from __future__ import annotations

import argparse
import collections
import html
import json
import math
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def sig3(value: float) -> int:
    if value == 0:
        return 0
    digits = 3 - int(math.floor(math.log10(abs(value)))) - 1
    return int(round(value, digits))


def libcal(folder: Path) -> dict:
    events = {}
    days = sorted({p.name.split("-p")[0] for p in folder.glob("*.json")})
    for path in sorted(folder.glob("*.json")):
        for event in json.loads(path.read_text(encoding="utf-8")).get("results", []):
            events[event["id"]] = event

    def cats(event) -> set[str]:
        return {c.get("name", "") for c in event.get("categories_arr") or []}

    def repeats(items) -> list[tuple[str, int]]:
        counter = collections.Counter(e["title"].strip() for e in items)
        return sorted(((t, n) for t, n in counter.items() if n > 1), key=lambda x: (-x[1], x[0]))

    workshops = [e for e in events.values() if "Workshop" in cats(e)]
    non_exhibition = [e for e in events.values() if "Exhibition" not in cats(e)]
    out = {
        "window": [days[0], days[-1]] if days else None,
        "days": len(days),
        "events": len(events),
        "distinct_titles": len({e["title"].strip() for e in events.values()}),
        "workshop_events": len(workshops),
        "workshop_distinct_titles": len({e["title"].strip() for e in workshops}),
        "workshop_repeated_titles": repeats(workshops),
        "non_exhibition_events": len(non_exhibition),
        "non_exhibition_repeated_titles": repeats(non_exhibition),
        "repeated_titles": repeats(events.values()),
    }
    out["workshop_repeat_events"] = sum(n for _, n in out["workshop_repeated_titles"])
    out["non_exhibition_repeat_events"] = sum(n for _, n in out["non_exhibition_repeated_titles"])
    out["repeat_events"] = sum(n for _, n in out["repeated_titles"])
    return out


def ntu(folder: Path) -> dict:
    clubs_page = (folder / "special-interest-clubs.html").read_text(encoding="utf-8", errors="replace")
    su_page = (folder / "ntu-students-union-council.html").read_text(encoding="utf-8", errors="replace")
    halls_page = (folder / "clubs-groups-societies.html").read_text(encoding="utf-8", errors="replace")
    clubs = re.findall(r'<a class="img-card"', clubs_page)
    heading = su_page.find("Constituent Clubs")
    su_cards = re.findall(r'<a class="img-card"', su_page[heading:]) if heading >= 0 else []
    halls_text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", halls_page)))
    halls = re.search(r"There are (\d+) Halls of Residence", halls_text)
    su_text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", su_page)))
    su_quote = re.search(r"The Union consists of (\d+) academic constituent clubs and (\d+) non-academic constituent clubs", su_text)
    out = {
        "special_interest_clubs": len(clubs),
        "su_constituent_clubs": len(su_cards),
        "su_constituent_clubs_quoted": (int(su_quote.group(1)) + int(su_quote.group(2))) if su_quote else None,
        "hall_councils": int(halls.group(1)) if halls else None,
    }
    out["student_orgs"] = out["special_interest_clubs"] + out["su_constituent_clubs"] + (out["hall_councils"] or 0)
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", default="2026-10-17", help="capture folder results/market/<date>")
    args = parser.parse_args(argv)
    base = REPO / "results" / "market" / args.date
    raw = base / "raw"
    inputs = json.loads((HERE / "inputs.json").read_text(encoding="utf-8"))
    cited = {k: v["value"] for k, v in inputs["cited"].items()}
    price = inputs["price_sgd_per_year"]["value"]

    counts = {"date": args.date, "nus_libcal": libcal(raw / "libcal" / "nus"), "smu_libcal": libcal(raw / "libcal" / "smu"),
              "ntu": ntu(raw / "ntu"), "cited": cited, "price_sgd_per_year": price}
    n_clubs = cited["nus_student_orgs"] + counts["ntu"]["student_orgs"] + cited["smu_student_orgs"] + cited["sutd_student_groups"] + cited["sit_student_orgs"]
    n_fetched = counts["ntu"]["student_orgs"] + cited["sutd_student_groups"] + cited["smu_student_orgs_fetched"]
    n_cet = cited["cet_training_providers"]
    counts["derived"] = {
        "student_orgs_five_universities": n_clubs,
        "student_orgs_fetched_or_own_count": n_fetched,
        "tam_campus_sgd_per_p": n_clubs * price,
        "tam_campus_sgd_per_p_3sf": sig3(n_clubs * price),
        "tam_campus_cet_sgd_per_p": (n_clubs + n_cet) * price,
        "tam_campus_cet_sgd_per_p_3sf": sig3((n_clubs + n_cet) * price),
        "tam_campus_fetched_sgd_per_p": n_fetched * price,
        "tam_campus_fetched_sgd_per_p_3sf": sig3(n_fetched * price),
        "som_nus_max_sgd": cited["nus_student_orgs"] * price,
    }
    (base / "counts.json").write_text(json.dumps(counts, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    nus, smu, n, d = counts["nus_libcal"], counts["smu_libcal"], counts["ntu"], counts["derived"]
    lines = [
        f"# Market sizing own counts ({args.date})",
        "",
        f"Generated by `tools/market/count.py` from `results/market/{args.date}/raw/` (captured by `tools/market/capture.py`) and",
        "`tools/market/inputs.json` (cited counts). Method: docs/market-sizing.md §1-§3; sources: report/sources.md §4.",
        "",
        "| quantity | value | basis |",
        "|---|---|---|",
        f"| NUS Libraries calendar: events listed {nus['window'][0]} to {nus['window'][1]} | {nus['events']} | union over {nus['days']} daily lists, by event id |",
        f"| NUS: events tagged Workshop | {nus['workshop_events']} | category 'Workshop' ({nus['workshop_distinct_titles']} distinct titles) |",
        f"| NUS: Workshop events that repeat a title | {nus['workshop_repeat_events']} | " + "; ".join(f"{t} x {k}" for t, k in nus["workshop_repeated_titles"]) + " |",
        f"| NUS: non-exhibition events / in repeated titles | {nus['non_exhibition_events']} / {nus['non_exhibition_repeat_events']} | " + "; ".join(f"{t} x {k}" for t, k in nus["non_exhibition_repeated_titles"]) + " |",
        f"| SMU Libraries calendar: events listed {smu['window'][0]} to {smu['window'][1]} | {smu['events']} | {smu['distinct_titles']} distinct titles |",
        f"| SMU: events that repeat a title | {smu['repeat_events']} | " + "; ".join(f"{t} x {k}" for t, k in smu["repeated_titles"]) + " |",
        f"| NTU special-interest clubs | {n['special_interest_clubs']} | club cards on the directory page |",
        f"| NTU Students' Union constituent clubs | {n['su_constituent_clubs']} | cards under 'Constituent Clubs' (page text: {n['su_constituent_clubs_quoted']}) |",
        f"| NTU hall councils | {n['hall_councils']} | 'There are {n['hall_councils']} Halls of Residence', one council each |",
        f"| NTU student organisations (own count) | {n['student_orgs']} | sum of the three rows above |",
        f"| Student organisations, five universities | {d['student_orgs_five_universities']} | NUS {cited['nus_student_orgs']} + NTU {n['student_orgs']} + SMU {cited['smu_student_orgs']} + SUTD {cited['sutd_student_groups']} + SIT {cited['sit_student_orgs']} (lower bound) |",
        f"| Sensitivity: fetched or own counts only | {d['student_orgs_fetched_or_own_count']} | NTU {n['student_orgs']} + SUTD {cited['sutd_student_groups']} + SMU (2025 page) {cited['smu_student_orgs_fetched']} |",
        f"| TAM campus, S$ per year per unit of p | {d['tam_campus_sgd_per_p']:,} (3 s.f. {d['tam_campus_sgd_per_p_3sf']:,}) | N x S${price} |",
        f"| TAM campus + CET, S$ per year per unit of p | {d['tam_campus_cet_sgd_per_p']:,} (3 s.f. {d['tam_campus_cet_sgd_per_p_3sf']:,}) | (N + {n_cet}) x S${price} |",
        f"| TAM sensitivity, S$ per year per unit of p | {d['tam_campus_fetched_sgd_per_p']:,} (3 s.f. {d['tam_campus_fetched_sgd_per_p_3sf']:,}) | {n_fetched} x S${price} |",
        f"| SOM upper bound, NUS only (p = a = 1), S$ per year | {d['som_nus_max_sgd']:,} | {cited['nus_student_orgs']} x S${price} |",
        "",
    ]
    (base / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {(base / 'counts.json').relative_to(REPO).as_posix()} and summary.md")
    print("\n".join(lines[5:]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
