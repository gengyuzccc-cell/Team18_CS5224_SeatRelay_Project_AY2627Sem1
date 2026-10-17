import { describe, expect, it } from 'vitest';
import { cutLength, Director, ffmpegArgs, filterValue, planClips } from '../src/lib/director';

describe('Director', () => {
  it('closes the open segment when the next actor takes the screen', () => {
    let now = 1_000;
    const director = new Director(() => now);
    director.cut('organiser', 'creates a workshop');
    now = 5_000;
    director.cut('alice', 'registers', 2);
    now = 9_000;
    director.close();
    director.close();
    expect(director.segments).toEqual([
      { actor: 'organiser', caption: 'creates a workshop', speed: 1, start: 1_000, end: 5_000 },
      { actor: 'alice', caption: 'registers', speed: 2, start: 5_000, end: 9_000 },
    ]);
    expect(director.current).toBeUndefined();
  });
});

describe('planClips', () => {
  const sources = [
    { actor: 'organiser', path: '/v/org.webm', startedAt: 1_000, duration: 60 },
    { actor: 'alice', path: '/v/alice.webm', startedAt: 20_000, duration: 30 },
  ];

  it('maps wall-clock segments onto each recording', () => {
    const clips = planClips(
      [
        { actor: 'organiser', caption: 'a', speed: 1, start: 1_000, end: 21_000 },
        { actor: 'alice', caption: 'b', speed: 4, start: 21_000, end: 41_000 },
      ],
      sources,
    );
    expect(clips).toEqual([
      { path: '/v/org.webm', offset: 0, duration: 20, caption: 'a', speed: 1, actor: 'organiser' },
      { path: '/v/alice.webm', offset: 1, duration: 20, caption: 'b', speed: 4, actor: 'alice' },
    ]);
    expect(cutLength(clips)).toBe(25);
  });

  it('clamps to the recording and drops what is too short or has no recording', () => {
    const clips = planClips(
      [
        // starts before Alice's recording and runs past its end
        { actor: 'alice', caption: 'clamped', speed: 1, start: 15_000, end: 90_000 },
        { actor: 'organiser', caption: 'too short', speed: 1, start: 30_000, end: 30_100 },
        { actor: 'bob', caption: 'no video', speed: 1, start: 30_000, end: 40_000 },
      ],
      sources,
    );
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ caption: 'clamped', offset: 0, duration: 30 });
  });
});

describe('ffmpegArgs', () => {
  const clip = {
    path: '/v/a.webm',
    offset: 1.5,
    duration: 10,
    caption: 'x',
    speed: 4,
    actor: 'alice',
  };
  const base = {
    output: '/out/demo.mp4',
    fontFile: '/fonts/DejaVuSans.ttf',
    captionFiles: ['/c/0.txt'],
    labelFiles: ['/c/l0.txt'],
    pageWidth: 1440,
    pageHeight: 900,
    barHeight: 72,
    outputWidth: 1280,
    crf: 28,
  };

  it('trims each clip at input level, speeds it up, adds the caption bar and encodes H.264', () => {
    const args = ffmpegArgs([clip], { ...base, introFiles: ['/c/i0.txt'], introSeconds: 3 });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6)).toEqual([
      '-ss',
      '1.500',
      '-t',
      '10.000',
      '-i',
      '/v/a.webm',
    ]);
    expect(args).toContain('color=c=0x111827:s=1440x972:r=25');
    const graph = args[args.indexOf('-filter_complex') + 1] as string;
    expect(graph).toContain('[0:v]drawtext=fontfile=/fonts/DejaVuSans.ttf:textfile=/c/i0.txt');
    expect(graph).toContain('[1:v]setpts=(PTS-STARTPTS)/4');
    expect(graph).toContain('pad=1440:972:0:0');
    expect(graph).toContain('textfile=/c/0.txt');
    expect(graph).toContain('[intro][c0]concat=n=2:v=1:a=0[cat]');
    expect(graph).toContain('scale=1280:-2');
    expect(args).toContain('libx264');
    expect(args.at(-1)).toBe('/out/demo.mp4');
  });

  it('refuses an empty cut or a caption count mismatch', () => {
    expect(() => ffmpegArgs([], base)).toThrow(/no clips/);
    expect(() => ffmpegArgs([clip, clip], base)).toThrow(/one caption/);
  });

  it('escapes filter option values', () => {
    expect(filterValue("C:\\a b's[1],x;y")).toBe("C\\:\\\\a b\\'s\\[1\\]\\,x\\;y");
  });
});
