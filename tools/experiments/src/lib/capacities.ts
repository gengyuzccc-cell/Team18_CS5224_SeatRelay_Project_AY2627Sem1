import { CliError, intOption, stringOption } from '@seatrelay/scripts';

/** plan §4 Concurrency: 3 sessions with 5 seats in total. */
export const DEFAULT_CAPACITIES = [2, 2, 1];

/**
 * Session capacities from the CLI: `--capacities 2,2,1`, or `--sessions N --capacity C`
 * (N × C; the missing one defaults to 3 sessions / 5 seats), or the plan default 2,2,1.
 */
export function capacitiesFrom(values: Record<string, unknown>): number[] {
  const list = stringOption(values, 'capacities');
  const uniform = values.sessions !== undefined || values.capacity !== undefined;
  if (list !== undefined && uniform) {
    throw new CliError('use either --capacities or --sessions/--capacity');
  }
  const capacities =
    list !== undefined
      ? list.split(',').map((item) => Number(item.trim()))
      : uniform
        ? Array.from({ length: intOption(values, 'sessions', 3) }, () =>
            intOption(values, 'capacity', 5),
          )
        : [...DEFAULT_CAPACITIES];
  if (capacities.some((capacity) => !Number.isInteger(capacity) || capacity < 1)) {
    throw new CliError(
      `session capacities must be positive integers (got ${capacities.join(',')})`,
    );
  }
  if (capacities.length < 2 || capacities.length > 5) {
    throw new CliError(`2..5 sessions are needed (got ${capacities.length})`);
  }
  return capacities;
}
