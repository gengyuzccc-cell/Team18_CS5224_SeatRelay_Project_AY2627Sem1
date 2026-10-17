import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

/**
 * Chromium executable to launch. `playwright` is pinned to the release whose browser build is
 * installed on the team machines (1.56.1 ↔ chromium-1194), so normally Playwright finds its own
 * build and this returns `undefined`. `CHROMIUM_PATH` overrides; if the expected build is missing,
 * the newest `chromium-<rev>` under `PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`) is
 * used instead. `playwright install` is never run.
 */
export function resolveChromium(): string | undefined {
  const override = process.env.CHROMIUM_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  try {
    if (existsSync(chromium.executablePath())) {
      return undefined;
    }
  } catch {
    // fall through to the directory scan
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) {
    return undefined;
  }
  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    const candidate = join(root, build, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function launchChromium(options: {
  headed: boolean;
  slowMo?: number;
}): Promise<{ browser: Browser; executablePath: string }> {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
  });
  return { browser, executablePath: executablePath ?? chromium.executablePath() };
}
