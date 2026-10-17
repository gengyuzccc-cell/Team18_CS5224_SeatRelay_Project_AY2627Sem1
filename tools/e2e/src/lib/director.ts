/**
 * One video from several browser contexts. Playwright records one video per page (here: one per
 * person), so the walkthrough keeps a timeline of whose window is "on screen" while it acts, and
 * the cut takes each segment from that person's recording. Waits can be sped up (`speed`), and a
 * caption bar under the page says who is acting, what happens and that the run is staged.
 *
 * Everything here is pure (no I/O), so the time mapping and the ffmpeg arguments are unit-tested.
 */

export interface Segment {
  actor: string;
  /** Wall-clock epoch milliseconds. */
  start: number;
  end: number;
  caption: string;
  /** Playback speed-up of the segment (1 = real time). */
  speed: number;
}

export class Director {
  readonly segments: Segment[] = [];
  #open: Omit<Segment, 'end'> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Puts `actor`'s window on screen from now on, with a caption; closes the previous segment. */
  cut(actor: string, caption: string, speed = 1): void {
    this.close();
    this.#open = { actor, caption, speed, start: this.now() };
  }

  close(): void {
    if (this.#open !== undefined) {
      this.segments.push({ ...this.#open, end: this.now() });
      this.#open = undefined;
    }
  }

  get current(): Omit<Segment, 'end'> | undefined {
    return this.#open;
  }
}

export interface VideoSource {
  actor: string;
  path: string;
  /** Wall-clock epoch milliseconds of the recording's first frame. */
  startedAt: number;
  /** Seconds. */
  duration: number;
}

export interface Clip {
  path: string;
  /** Seconds into the source recording. */
  offset: number;
  /** Seconds of source material. */
  duration: number;
  caption: string;
  speed: number;
  actor: string;
}

/**
 * Maps the wall-clock segments onto the recordings. Segments of an actor without a recording,
 * and clips shorter than `minSeconds` after clamping to the recording, are dropped.
 */
export function planClips(
  segments: readonly Segment[],
  sources: readonly VideoSource[],
  minSeconds = 0.3,
): Clip[] {
  const byActor = new Map(sources.map((source) => [source.actor, source]));
  const clips: Clip[] = [];
  for (const segment of segments) {
    const source = byActor.get(segment.actor);
    if (source === undefined) {
      continue;
    }
    const from = Math.max(0, (segment.start - source.startedAt) / 1000);
    const to = Math.min(source.duration, (segment.end - source.startedAt) / 1000);
    if (to - from < minSeconds) {
      continue;
    }
    clips.push({
      path: source.path,
      offset: round3(from),
      duration: round3(to - from),
      caption: segment.caption,
      speed: segment.speed,
      actor: segment.actor,
    });
  }
  return clips;
}

/** Length of the cut in seconds (after speed-ups), without the intro card. */
export function cutLength(clips: readonly Clip[]): number {
  return clips.reduce((sum, clip) => sum + clip.duration / clip.speed, 0);
}

export interface CutOptions {
  output: string;
  fontFile: string;
  /** One caption text file per clip (drawtext `textfile`, so no escaping is needed). */
  captionFiles: readonly string[];
  /** One right-hand label file per clip ("Staged walkthrough · dev · 4× speed"). */
  labelFiles: readonly string[];
  /** Optional intro card: text files, one per line of the card. */
  introFiles?: readonly string[];
  introSeconds?: number;
  /** Source page size (the recordings' size). */
  pageWidth: number;
  pageHeight: number;
  /** Caption bar height added under the page. */
  barHeight: number;
  /** Output width; height follows the aspect ratio. */
  outputWidth: number;
  crf: number;
  fps?: number;
}

/** ffmpeg arguments for the cut: trim each clip, speed up, add the caption bar, concat, H.264. */
export function ffmpegArgs(clips: readonly Clip[], options: CutOptions): string[] {
  if (clips.length === 0) {
    throw new Error('no clips to cut');
  }
  if (options.captionFiles.length !== clips.length || options.labelFiles.length !== clips.length) {
    throw new Error('one caption and one label file per clip');
  }
  const fps = options.fps ?? 25;
  const width = options.pageWidth;
  const height = options.pageHeight + options.barHeight;
  const font = filterValue(options.fontFile);
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  const filters: string[] = [];
  const labels: string[] = [];
  let input = 0;

  const intro = options.introFiles ?? [];
  if (intro.length > 0) {
    const seconds = options.introSeconds ?? 4;
    args.push(
      '-f',
      'lavfi',
      '-t',
      String(seconds),
      '-i',
      `color=c=0x111827:s=${width}x${height}:r=${fps}`,
    );
    const lineHeight = 52;
    const top = Math.round(height / 2 - (intro.length * lineHeight) / 2);
    const draws = intro.map(
      (file, i) =>
        `drawtext=fontfile=${font}:textfile=${filterValue(file)}:expansion=none:fontcolor=white:fontsize=${i === 0 ? 40 : 28}:x=(w-text_w)/2:y=${top + i * lineHeight}`,
    );
    filters.push(`[${input}:v]${draws.join(',')},setsar=1[intro]`);
    labels.push('[intro]');
    input += 1;
  }

  clips.forEach((clip, k) => {
    args.push('-ss', clip.offset.toFixed(3), '-t', clip.duration.toFixed(3), '-i', clip.path);
    const speed = clip.speed === 1 ? '' : `/${clip.speed}`;
    // Two lines in the bar: the caption (who acts, what happens) and, under it on the right, the
    // "Staged walkthrough" label, so a long caption can never run into the label.
    const barTop = options.pageHeight;
    const captionY = barTop + Math.round(options.barHeight * 0.12);
    const labelY = barTop + Math.round(options.barHeight * 0.6);
    filters.push(
      `[${input}:v]setpts=(PTS-STARTPTS)${speed},fps=${fps},scale=${width}:${options.pageHeight},` +
        `pad=${width}:${height}:0:0:color=0x111827,` +
        `drawtext=fontfile=${font}:textfile=${filterValue(options.captionFiles[k] as string)}:expansion=none:fontcolor=white:fontsize=24:x=20:y=${captionY},` +
        `drawtext=fontfile=${font}:textfile=${filterValue(options.labelFiles[k] as string)}:expansion=none:fontcolor=0xfbbf24:fontsize=18:x=w-text_w-20:y=${labelY},` +
        `setsar=1[c${k}]`,
    );
    labels.push(`[c${k}]`);
    input += 1;
  });

  filters.push(
    `${labels.join('')}concat=n=${labels.length}:v=1:a=0[cat]`,
    `[cat]scale=${options.outputWidth}:-2:flags=lanczos,format=yuv420p[out]`,
  );
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    String(options.crf),
    '-r',
    String(fps),
    '-movflags',
    '+faststart',
    options.output,
  );
  return args;
}

/** Escapes a value for an ffmpeg filter option (`:`, `\`, `'`, and the graph separators). */
export function filterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/([[\],;])/g, '\\$1');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
