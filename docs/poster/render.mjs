// Prints docs/poster/poster.html (A1 portrait, 594 x 841 mm) with Chromium: a 150 dpi PNG for the
// STePS "poster image" link and a vector PDF for the A1 print. Playwright comes from tools/e2e.
//   node docs/poster/render.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../tools/e2e/package.json'));
const { chromium } = require('playwright');

const MM_PER_IN = 25.4;
const CSS_PX_PER_IN = 96;
const DPI = 150;
const width = Math.round((594 / MM_PER_IN) * CSS_PX_PER_IN);
const height = Math.round((841 / MM_PER_IN) * CSS_PX_PER_IN);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: DPI / CSS_PX_PER_IN,
    colorScheme: 'light',
  });
  await page.goto(pathToFileURL(join(here, 'poster.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => {
    const poster = document.querySelector('.poster');
    const problems = [];
    for (const el of poster.querySelectorAll('*')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') problems.push(el.className);
    }
    const r = poster.getBoundingClientRect();
    if (poster.scrollHeight > poster.clientHeight + 1) problems.push(`poster content ${poster.scrollHeight}px > ${poster.clientHeight}px`);
    // nothing in the three columns may reach into the footer, and no SVG may be squeezed below its set width
    const footerTop = poster.querySelector('footer').getBoundingClientRect().top;
    for (const el of poster.querySelectorAll('.cols *')) {
      if (el.getBoundingClientRect().bottom > footerTop + 0.5) problems.push(`${el.tagName.toLowerCase()}.${el.className?.baseVal ?? el.className} overlaps the footer`);
    }
    for (const svg of poster.querySelectorAll('svg[width$="mm"]')) {
      const want = parseFloat(svg.getAttribute('width')) * 96 / 25.4;
      const got = svg.getBoundingClientRect().width;
      if (Math.abs(got - want) > 2) problems.push(`svg.${svg.getAttribute('class')} drawn ${got.toFixed(0)}px wide, set ${want.toFixed(0)}px`);
    }
    // each column must end inside the grid (above the footer's margin); report the space left in each
    const mm = (px) => px * 25.4 / 96;
    const colsBottom = poster.querySelector('.cols').getBoundingClientRect().bottom;
    const free = [...poster.querySelectorAll('.cols > .col')].map((col, i) => {
      const bottom = Math.max(...[...col.querySelectorAll('*')].map((el) => el.getBoundingClientRect().bottom));
      if (bottom > colsBottom + 0.5) problems.push(`column ${i + 1} runs ${mm(bottom - colsBottom).toFixed(1)} mm past the grid`);
      return mm(colsBottom - bottom).toFixed(1);
    });
    return { problems, size: [r.width, r.height], free };
  });
  console.log(`space left at the bottom of the columns: ${overflow.free.join(' / ')} mm`);
  if (overflow.problems.length > 0) {
    console.error('layout overflow:', overflow.problems.join(', '));
    process.exitCode = 1;
  }
  await page.screenshot({ path: join(here, 'seatrelay-steps-poster.png'), fullPage: false });
  await page.pdf({
    path: join(here, 'seatrelay-steps-poster.pdf'),
    width: '594mm',
    height: '841mm',
    printBackground: true,
    pageRanges: '1',
  });
  console.log(`rendered ${width}x${height} CSS px at ${DPI} dpi -> seatrelay-steps-poster.png, seatrelay-steps-poster.pdf`);
} finally {
  await browser.close();
}
