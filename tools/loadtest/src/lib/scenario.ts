import fs from 'node:fs';
import path from 'node:path';
import { LOADTEST_DIR, resolveUserPath } from '@seatrelay/scripts';

/**
 * `tools/loadtest/.scenario.<target>.json` — the workshops `prepare.ts` created for the k6
 * scenarios (git-ignored; ids belong to one deployment).
 */
export interface ScenarioWorkshop {
  title: string;
  sessionIds: string[];
  capacity: number;
  holdSeconds: number;
}

export interface ScenarioFile {
  target: string;
  apiBase: string;
  createdAt: string;
  organiserEmail: string;
  orgId: string;
  scenarios: Record<string, { workshopIds: string[] }>;
  workshops: Record<string, ScenarioWorkshop>;
}

export const SCENARIO_NAMES = ['cross-workshop', 'hotspot'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function scenarioFilePath(target: string, override?: string): string {
  if (override !== undefined && override.length > 0) {
    return resolveUserPath(override);
  }
  return path.join(LOADTEST_DIR, `.scenario.${target}.json`);
}

export function readScenarioFile(file: string): ScenarioFile | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ScenarioFile>;
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.scenarios !== 'object') {
    throw new Error(`${file} is not a scenario file`);
  }
  return parsed as ScenarioFile;
}

export function writeScenarioFile(file: string, data: ScenarioFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** All workshop ids of a scenario file (both scenarios, de-duplicated). */
export function scenarioWorkshopIds(file: ScenarioFile | undefined): string[] {
  if (file === undefined) {
    return [];
  }
  return [...new Set(Object.values(file.scenarios).flatMap((entry) => entry.workshopIds))];
}
