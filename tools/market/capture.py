#!/usr/bin/env python3
"""Capture the public pages behind the own counts of the market sizing (docs/market-sizing.md §2).

Writes the raw responses, unmodified, to ``results/market/<date>/raw/``:

  libcal/<campus>/<YYYY-MM-DD>-p<n>.json   the event list of one day, as the public LibCal
                                           calendar page requests it (rows 13-14)
  ntu/<name>.html                          the three NTU directory pages (row 4)
  capture.json                             URL, HTTP status, byte count and UTC time per file

``count.py`` reads only these files. Usage (no credentials; plain HTTPS GETs):

  python3 -I tools/market/capture.py [--date 2026-10-17] [--from 2026-08-01] [--to 2026-10-16]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

LIBCAL = {
    "nus": "https://nus.libcal.com/ajax/calendar/list?c=-1&date={date}&perpage=100&page={page}&audience=&cats=&camps=&inc=0",
    "smu": "https://smu-sg.libcal.com/ajax/calendar/list?c=-1&date={date}&perpage=100&page={page}&audience=&cats=&camps=&inc=0",
}
NTU = {
    "special-interest-clubs": "https://www.ntu.edu.sg/life-at-ntu/student-life/student-activities-and-engagement/clubs-groups-societies/special-interest-clubs",
    "ntu-students-union-council": "https://www.ntu.edu.sg/life-at-ntu/student-life/student-activities-and-engagement/clubs-groups-societies/ntu-students-union-council",
    "clubs-groups-societies": "https://www.ntu.edu.sg/life-at-ntu/student-life/student-activities-and-engagement/clubs-groups-societies",
}
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) SeatRelay-market-capture", "X-Requested-With": "XMLHttpRequest"}


def get(url: str) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 (fixed https URLs)
        return response.status, response.read()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", default=dt.date.today().isoformat(), help="capture date (output folder name)")
    parser.add_argument("--from", dest="start", default="2026-08-01", help="first calendar day")
    parser.add_argument("--to", dest="end", default="2026-10-16", help="last calendar day")
    args = parser.parse_args(argv)
    raw = REPO / "results" / "market" / args.date / "raw"
    log = []

    def save(path: Path, url: str) -> bytes:
        status, body = get(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        log.append({"file": path.relative_to(raw).as_posix(), "url": url, "status": status, "bytes": len(body),
                    "retrievedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")})
        time.sleep(0.2)
        return body

    day = dt.date.fromisoformat(args.start)
    last = dt.date.fromisoformat(args.end)
    while day <= last:
        for campus, template in LIBCAL.items():
            page = 1
            while True:
                body = save(raw / "libcal" / campus / f"{day.isoformat()}-p{page}.json", template.format(date=day.isoformat(), page=page))
                data = json.loads(body)
                if page * int(data.get("perpage") or 100) >= int(data.get("total_results") or 0):
                    break
                page += 1
        day += dt.timedelta(days=1)
    for name, url in NTU.items():
        save(raw / "ntu" / f"{name}.html", url)
    (raw / "capture.json").write_text(json.dumps(log, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(log)} files to {raw.relative_to(REPO).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
