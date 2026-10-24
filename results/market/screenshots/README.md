# Dated browser screenshots of the cited student-organisation counts (2026-10-24)

Evidence for `docs/market-sizing.md` §2 rows 3, 5 and 7 and §8, `report/sources.md` §4, and
`docs/SUBMISSION-CHECKLIST.md` row 1.3. On 2026-10-17 these three counts could only be read from
search-engine excerpts. On 2026-10-24 each official page was opened in a real browser engine
(headless Chromium 141.0.7390.37 through Playwright 1.56.1, the copy in `tools/e2e`, desktop
Chrome user agent, viewport 1440 × 900) by `capture.mjs` in this folder. Every screenshot is an
unmodified capture of what the browser rendered, apart from the two additions described under
"What the script adds".

## Results

| Key | URL | Route | Captured (UTC) | HTTP | Sentence with the count (exact) | Files |
|---|---|---|---|---|---|---|
| `nus-osa-getstarted` | https://osa.nus.edu.sg/experience-communities/leadership/student-leader-resources/get-started/ | live | 2026-10-24 06:34:11 | 200 | "NUS has more than 200 official student organisations." | `nus-osa-getstarted-2026-10-24.png`, `nus-osa-getstarted-2026-10-24-full.png`, `nus-osa-getstarted-2026-10-24.txt` |
| `sit-find-your-tribe` | https://www.singaporetech.edu.sg/life-at-sit/find-your-tribe | live | 2026-10-24 06:34:22 | 200 | "With over 170 student organisations spanning various interests, we cultivate a vibrant, safe, and inclusive campus community." | `sit-find-your-tribe-2026-10-24.png`, `sit-find-your-tribe-2026-10-24-full.png`, `sit-find-your-tribe-2026-10-24.txt` |
| `smu-osl-2022` (cited page) | https://orientation.smu.edu.sg/2022/student-life/offices/office-of-student-life-osl | live, en-SG context (route 1) | 2026-10-24 06:35:20 | 403 | none: the page shows "ACCESS DENIED / You are not authorized to access this page." | `smu-osl-2022-2026-10-24.png`, `smu-osl-2022-2026-10-24-full.png`, `smu-osl-2022-2026-10-24.txt` |
| `smu-osl-2022` (cited page) | https://web.archive.org/web/20230131040749/https://orientation.smu.edu.sg/2022/student-life/offices/office-of-student-life-osl | Wayback capture 20230131040749 (route 2) | 2026-10-24, attempt right after 06:35 (no page, so no capture time) | 502 from this sandbox's egress proxy | not loaded: no screenshot | none |
| `smu-osl-2022` → alternative official page | https://www.smu.edu.sg/campus-life/student-experiences | alternative page (route 3) | 2026-10-24 06:34:39 | 200 | "From over 150 student clubs and societies to meaningful leadership opportunities, build a university life that reflects who you are." | `smu-student-experiences-2026-10-24.png`, `smu-student-experiences-2026-10-24-full.png`, `smu-student-experiences-2026-10-24.txt` |

`<key>-2026-10-24.png` is the 1440 × 900 viewport with the sentence scrolled to the centre;
`-full.png` is the whole page from the top (every full-page PNG was under 8 MB, so no JPEG
fallback was needed); `.txt` is the page's visible text (`document.body.innerText`), read before
the script added anything. `capture-log-2026-10-24.json` holds, per attempt, the HTTP status, final
URL, page title, server `Date` and `Last-Modified` headers, page date metadata, the matched
sentence, the outlined element, the banner text and the SHA-256 and size of each file.

SHA-256 of the PNGs:

| File | SHA-256 |
|---|---|
| `nus-osa-getstarted-2026-10-24.png` | `fcee5569e6314c0db115be614cf6ff30b6f7c58fe4c7981fb5caa49f5d8391a8` |
| `nus-osa-getstarted-2026-10-24-full.png` | `85098ee0230d4a4f06b489817230242c53205d519ba34631898b07d3799f02c5` |
| `sit-find-your-tribe-2026-10-24.png` | `03525814b3f2bf503d959ca1263cb59909d5044cf5e138db23c9457fc3b96ccc` |
| `sit-find-your-tribe-2026-10-24-full.png` | `23ad1477cdf8f48572dfebeff3b34e9da9db70578b82983bfdc16bda62b440e0` |
| `smu-osl-2022-2026-10-24.png` | `4de73b41bcbfc3be8ff82c9b5c33efb0db11e6b06d5e0047c0c00cdde498872f` |
| `smu-osl-2022-2026-10-24-full.png` | `4de73b41bcbfc3be8ff82c9b5c33efb0db11e6b06d5e0047c0c00cdde498872f` (identical: the error page is shorter than the viewport) |
| `smu-student-experiences-2026-10-24.png` | `49d5a3c5d1d2bc75384d838e1e6b6fcedd436f70624726661f18be6d13a429d5` |
| `smu-student-experiences-2026-10-24-full.png` | `a57de9da0c39f2c83133553fd906f36d0d497815ea782fcddf7032903c97237d` |

## What each capture shows

- **NUS (row 3): confirmed, 200.** The sentence is unchanged from the 2026-10-17 excerpt. Page
  metadata: `datePublished` 2024-02-27, `dateModified` 2026-06-17. In the served text, the space
  between "than" and "200" is a narrow no-break space (U+202F).
- **SIT (row 7): the figure has changed, 150 → 170.** The page now says "With over 170 student
  organisations …", and again further down: "Club Fair, where more than 170 student organisations
  inspire students to explore opportunities beyond the classroom". "150" occurs nowhere in the
  visible text or in the rendered DOM (the capture log checks both). The server reported
  `Last-Modified: Thu, 22 Oct 2026 05:57:25 GMT`, after the 2026-10-17 excerpt was read. The
  figure now agrees with Life@SIT (`sit-life`, "170+ Student Organisations"; on 2026-10-24 that
  page also said "We support 170+ student groups for a vibrant, inclusive campus", text probe
  only, no screenshot).
- **SMU (row 5): the cited 2022 page is no longer public; the same figure is on SMU's main site.**
  The 2022 orientation page returns HTTP 403 with the orientation site's own Drupal "Access denied"
  page. This is a page-level denial, not bot protection: in the same session the site root and the
  2025 orientation page (`smu-cb-2025`) returned 200. Route 1 (locale en-SG, timezone
  Asia/Singapore, Accept-Language and client-hint headers, a 30 s wait) gave the same 403 with no
  interstitial. A plain-context attempt at 06:19 UTC, not kept, also got 403. Route 2:
  `archive.org/wayback/available` lists a capture of the exact URL at **20230131040749** (status
  200), but web.archive.org could not be reached from this sandbox: the TLS handshake was reset
  upstream for curl, and Chromium got 502 "upstream request failed" from the egress proxy. So no
  archive screenshot exists. A team member can open that Wayback URL in an ordinary browser.
  Route 3 worked: SMU's "Co-curricular & Student Life Experiences" page states "over 150 student
  clubs and societies". This agrees with the cited "150+ student organizations", so the count of
  150 stands, but it now rests on a different page. In the served text that sentence ends with a
  zero-width space (U+200B). The `.txt` keeps it; the quote above omits it.

## What the script adds to the page (the only changes)

1. **A banner** fixed at the top of the viewport (black, 12 px Arial, red bottom border). It states
   the capture time in UTC and SGT, the URL, the HTTP status, "alternative official page for
   smu-osl-2022" where that applies, the browser, and that the banner (and outline) were added by
   the capture script. It covers about the top 30–45 px of the page header. In the full-page
   images it appears once, at the top.
2. **A thin red outline** (CSS `outline: 2px solid #d00000; outline-offset: 2px`) around the
   smallest visible element whose text contains the sentence with the count. For SIT that element
   is the whole introductory paragraph; for NUS and SMU it is the paragraph's container. The
   element is then scrolled to the centre of the viewport for the viewport image. The SMU 403 page
   has no such sentence, so it has no outline, and its banner says so.

Nothing else was changed: no text was edited, and cookie dialogs were not dismissed (SMU's cookie
dialog and its grey overlay are visible as rendered). Lazy-loaded images that had not loaded when
the full page was taken appear as their alt text (SIT club logos). The script reloads a page at
most twice if its stylesheets did not apply, which it detects when the body is still in the
browser's default serif font; the log records the number of reloads (0 for all kept captures). This
was added because one rehearsal render of the SIT page arrived unstyled.

## Re-running

```
node results/market/screenshots/capture.mjs --route live nus-osa-getstarted sit-find-your-tribe smu-student-experiences
node results/market/screenshots/capture.mjs --route live-sg smu-osl-2022
node results/market/screenshots/capture.mjs --route wayback smu-osl-2022
```

These are the three commands that produced this folder, run from a scratchpad copy that is
byte-identical to `capture.mjs` (SHA-256 `e52b6d7e1d9d6858fbbaf31f9caf353c917ec26a1332912f512a82b659d57802`).
The script uses the Playwright of `tools/e2e` (no browser download). `REPO` at the top of the
script is the absolute checkout path used on 2026-10-24; change it to re-run on another machine.
Outputs are named by the UTC date of the run, so a re-run on another day adds files rather than
replacing these.
