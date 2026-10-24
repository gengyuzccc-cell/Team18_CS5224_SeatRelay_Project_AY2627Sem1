// Dated browser screenshots of the official pages behind the cited student-organisation counts
// (docs/market-sizing.md section 2, rows 3, 5, 7; report/sources.md section 4).
//
// For each target the script loads the page in Playwright's Chromium, saves the page's visible
// text (document.body.innerText, read BEFORE anything is added to the page), then makes exactly
// two additions to the rendered page and takes the screenshots:
//   1. a fixed banner at the top of the viewport stating the capture time (UTC and SGT), the URL,
//      the HTTP status and the browser, so the date is visible in the image;
//   2. a thin red CSS outline (2 px, offset 2 px) around the smallest element that contains the
//      sentence with the count, which is scrolled to the centre of the viewport.
// Nothing else on the page is changed (no cookie banners dismissed, no text edited).
//
// Outputs in --out (default results/market/screenshots):
//   <key>-<date>.png        1440x900 viewport, centred on the sentence
//   <key>-<date>-full.png   full page (JPEG q85 <key>-<date>-full.jpg instead if the PNG is > 8 MB)
//   <key>-<date>.txt        the page's visible text
//   capture-log-<date>.json status, final URL, title, matched sentence, SHA-256 of each file
//
// Usage (from the repo root; uses the Playwright of tools/e2e, no browser download):
//   node results/market/screenshots/capture.mjs [--route live|live-sg|wayback] [--out DIR] key ...
// Routes: live = normal desktop context; live-sg = the same plus locale en-SG, timezone
// Asia/Singapore and browser-like request headers, waiting up to 30 s for an interstitial to clear
// (no attempt is made to solve CAPTCHAs or bypass bot protection); wayback = the most recent
// Internet Archive capture of the URL (the Wayback toolbar, which shows the capture date, is kept).

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/home/user/Team18_CS5224_SeatRelay_Project_AY2627Sem1';
const require = createRequire(path.join(REPO, 'tools/e2e/package.json'));
const { chromium } = require('playwright');

const TARGETS = {
  'nus-osa-getstarted': {
    url: 'https://osa.nus.edu.sg/experience-communities/leadership/student-leader-resources/get-started/',
    needle: /NUS\s+has\s+more\s+than\s+\d+\s+official\s+student\s+organisations/,
  },
  'smu-osl-2022': {
    url: 'https://orientation.smu.edu.sg/2022/student-life/offices/office-of-student-life-osl',
    needle: /\d+\+?\s+student\s+organi[sz]ations\s+in\s+SMU/,
  },
  'sit-find-your-tribe': {
    url: 'https://www.singaporetech.edu.sg/life-at-sit/find-your-tribe',
    needle: /(over|more\s+than)\s+\d+\s+student\s+(organisations|clubs)/i,
  },
  // Alternative official SMU page (route 3 for smu-osl-2022, whose 2022 page now returns 403).
  'smu-student-experiences': {
    url: 'https://www.smu.edu.sg/campus-life/student-experiences',
    needle: /over\s+\d+\s+student\s+clubs/,
    alternativeFor: 'smu-osl-2022',
  },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_FULL_PNG = 8 * 1024 * 1024;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const route = opt('--route', 'live');
const outDir = path.resolve(opt('--out', path.join(REPO, 'results/market/screenshots')));
const keys = args.length ? args : Object.keys(TARGETS);
fs.mkdirSync(outDir, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d, offsetH) => { const t = new Date(d.getTime() + offsetH * 3600e3); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function waybackLatest(context, url) {
  // The availability API returns the capture closest to now, i.e. the most recent one.
  // archive.org rate-limits (HTTP 429), so retry a few times with a pause.
  let last = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await context.request.get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`).catch((e) => ({ ok: () => false, status: () => e.message }));
    if (res.ok()) {
      const snap = (await res.json())?.archived_snapshots?.closest;
      if (!snap?.available) return { none: true };
      return { timestamp: snap.timestamp, status: snap.status, url: snap.url.replace(/^http:/, 'https:') };
    }
    last = `availability API HTTP ${res.status()}`;
    await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
  }
  return { error: last };
}

const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const browserVersion = browser.version();
const contextOptions = { userAgent: UA, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
if (route === 'live-sg') {
  Object.assign(contextOptions, {
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    extraHTTPHeaders: {
      'Accept-Language': 'en-SG,en-GB;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    },
  });
}
const context = await browser.newContext(contextOptions);
const logPath = path.join(outDir, `capture-log-${new Date().toISOString().slice(0, 10)}.json`);
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];

for (const key of keys) {
  const target = TARGETS[key];
  if (!target) { console.error(`unknown key ${key}`); continue; }
  const entry = { key, url: target.url, route, browser: `Chromium ${browserVersion}` };
  if (target.alternativeFor) entry.alternative_for = target.alternativeFor;
  let loadUrl = target.url;
  if (route === 'wayback') {
    const snap = await waybackLatest(context, target.url);
    if (snap.none || snap.error) { entry.result = snap.error || 'no Wayback capture'; console.log(key, entry.result); log.push(entry); continue; }
    entry.wayback = snap;
    loadUrl = snap.url;
  }
  const page = await context.newPage();
  let lastNav = null; // status of the latest main-frame navigation (an interstitial may reload the page)
  page.on('response', (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastNav = r; });
  let response;
  try {
    response = await page.goto(loadUrl, { waitUntil: 'load', timeout: 90000 });
  } catch (e) {
    entry.result = `navigation error: ${e.message.split('\n')[0]}`;
    console.log(key, entry.result); log.push(entry); await page.close(); continue;
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  entry.first_status = response?.status();
  if (route === 'live-sg' && (lastNav?.status() ?? 0) >= 400) {
    // Give a JavaScript interstitial up to 30 s to clear by itself; nothing is clicked or solved.
    for (let i = 0; i < 30 && (lastNav?.status() ?? 0) >= 400; i += 1) await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  }
  if (lastNav) response = lastNav;
  // A page whose stylesheets did not apply renders in the browser's default serif font; reload it
  // (as a reader would) at most twice. The number of reloads is logged.
  const unstyled = () => page.evaluate(() => /times/i.test(getComputedStyle(document.body).fontFamily)).catch(() => false);
  entry.reloads = 0;
  while ((response?.status() ?? 0) < 400 && entry.reloads < 2 && await unstyled()) {
    entry.reloads += 1;
    response = await page.reload({ waitUntil: 'load', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  entry.unstyled = await unstyled();
  const status = response?.status();
  if (route === 'wayback' && (!status || status >= 400)) {
    // Never save an error page as if it were the archived page.
    entry.http_status = status; entry.result = `archived page did not load (HTTP ${status})`;
    console.log(JSON.stringify(entry, null, 1)); log.push(entry); await page.close(); continue;
  }
  await page.waitForTimeout(3000);
  const captured = new Date();
  entry.http_status = status;
  entry.final_url = page.url();
  entry.title = await page.title();
  entry.captured_utc = captured.toISOString();
  entry.server_date = response?.headers()['date'] ?? null;
  entry.last_modified = response?.headers()['last-modified'] ?? null;

  const text = await page.evaluate(() => document.body ? document.body.innerText : '');
  const date = entry.captured_utc.slice(0, 10);
  const base = path.join(outDir, `${key}-${date}`);
  fs.writeFileSync(`${base}.txt`, text.endsWith('\n') ? text : `${text}\n`);
  entry.files = { text: path.basename(`${base}.txt`) };

  const match = text.match(target.needle);
  if (match) {
    const at = match.index;
    const start = Math.max(text.lastIndexOf('\n', at), text.lastIndexOf('. ', at) >= 0 ? text.lastIndexOf('. ', at) + 1 : -1) + 1;
    let end = text.slice(at).search(/[.!?](\s|$)|\n/);
    end = end < 0 ? text.length : at + end + 1;
    entry.sentence = text.slice(start, end).replace(/[\u200b\ufeff]/g, '').trim(); // zero-width characters removed from the quote only
  } else {
    entry.sentence = null;
  }
  entry.numbers_in_text = [...new Set((text.match(/\b\d{2,3}\+?(?= ?(student|clubs|organi|interest|groups))/gi) || []))];
  entry.text_mentions_150 = /\b150\b/.test(text);
  const dom = await page.content(); // rendered DOM, including meta tags and hidden markup
  entry.dom_mentions_150 = [...dom.matchAll(/.{0,60}\b150\b.{0,60}/g)].map((m) => m[0]).slice(0, 5);
  entry.page_dates = await page.evaluate(() => {
    const out = {};
    for (const m of document.querySelectorAll('meta[property*="time"], meta[name*="date" i], meta[itemprop*="date" i]')) out[m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop')] = m.content;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const hit = s.textContent.match(/"date(Modified|Published)"\s*:\s*"([^"]+)"/g); if (hit) out.ld_json = hit;
    }
    return out;
  });


  const outlined = await page.evaluate(({ source, flags }) => {
    const re = new RegExp(source, flags);
    let best = null;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('#wm-ipp-base, #wm-ipp, #donato')) continue;
      const t = el.innerText;
      if (!t || !re.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (!best || t.length < best.innerText.length) best = el;
    }
    if (!best) return null;
    best.style.outline = '2px solid #d00000';
    best.style.outlineOffset = '2px';
    return { tag: best.tagName.toLowerCase(), text: best.innerText.slice(0, 300) };
  }, { source: target.needle.source, flags: target.needle.flags });
  entry.outlined_element = outlined;

  const banner = `Captured ${stamp(captured, 0)} UTC (${stamp(captured, 8).slice(11)} SGT, ${stamp(captured, 8).slice(0, 10)}) · ${loadUrl} · HTTP ${status} · `
    + (route === 'wayback' ? `Internet Archive capture ${entry.wayback.timestamp} · ` : '')
    + (target.alternativeFor ? `alternative official page for ${target.alternativeFor} · ` : '')
    + `headless Chromium ${browserVersion} (Playwright) · ` + (outlined ? 'this banner and the red outline were added by the capture script (capture.mjs)' : 'this banner was added by the capture script (capture.mjs); no sentence to outline');
  entry.banner = banner;

  await page.evaluate((label) => {
    const div = document.createElement('div');
    div.id = 'seatrelay-capture-banner';
    div.textContent = label;
    Object.assign(div.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
      background: '#111', color: '#fff', font: '12px/1.4 Arial, Helvetica, sans-serif',
      padding: '5px 10px', boxSizing: 'border-box', borderBottom: '2px solid #d00000',
      whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left',
    });
    document.documentElement.appendChild(div);
  }, banner);

  // (b) full page, from the top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  let fullPath = `${base}-full.png`;
  await page.screenshot({ path: fullPath, fullPage: true });
  if (fs.statSync(fullPath).size > MAX_FULL_PNG) {
    fs.unlinkSync(fullPath);
    fullPath = `${base}-full.jpg`;
    await page.screenshot({ path: fullPath, fullPage: true, type: 'jpeg', quality: 85 });
  }
  // (a) viewport, sentence centred
  if (outlined) {
    await page.evaluate(({ source, flags }) => {
      const re = new RegExp(source, flags);
      let best = null;
      for (const el of document.body.querySelectorAll('*')) {
        if (el.id === 'seatrelay-capture-banner' || el.closest('#wm-ipp-base, #wm-ipp, #donato')) continue;
        const t = el.innerText;
        if (!t || !re.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (!best || t.length < best.innerText.length) best = el;
      }
      best?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, { source: target.needle.source, flags: target.needle.flags });
    await page.waitForTimeout(1200);
  }
  const viewPath = `${base}.png`;
  await page.screenshot({ path: viewPath, fullPage: false });

  entry.files.viewport = path.basename(viewPath);
  entry.files.full = path.basename(fullPath);
  entry.sha256 = Object.fromEntries(Object.values(entry.files).map((f) => [f, sha256(path.join(outDir, f))]));
  entry.bytes = Object.fromEntries(Object.values(entry.files).map((f) => [f, fs.statSync(path.join(outDir, f)).size]));
  console.log(JSON.stringify(entry, null, 1));
  log.push(entry);
  await page.close();
}

fs.writeFileSync(logPath, JSON.stringify(log, null, 1) + '\n');
await browser.close();
