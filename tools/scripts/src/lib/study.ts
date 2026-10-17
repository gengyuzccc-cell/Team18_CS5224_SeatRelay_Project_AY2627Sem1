/**
 * The seeded state of the user study, transcribed from `docs/user-study/tasks-participant.md`
 * §1 and `docs/user-study/tasks-organiser.md` §1. `seed-study` reproduces these tables through
 * the API; the tests check the transcription against the counts the documents state.
 */

export const STUDY_TRACKS = ['participant', 'organiser'] as const;
export type StudyTrack = (typeof STUDY_TRACKS)[number];

export const STUDY_DATASETS = ['A', 'B'] as const;
export type StudyDataset = (typeof STUDY_DATASETS)[number];

export const STUDY_ORG_NAME = 'NUS Data Club';
export const STUDY_HOLD_SECONDS = 1800;
/** Singapore time; the API normalises to UTC. */
export const STUDY_UTC_OFFSET = '+08:00';
export const STUDY_EMAIL_DOMAIN = 'example.com';

export const STUDY_PERSONAS = {
  participant: { name: 'Jordan Lee', email: 'study.jordan@example.com' },
  organiser: { name: 'Riley Tan', email: 'study.riley@example.com' },
} as const;

export interface StudySessionSpec {
  /** S1 | S2 | S3 */
  key: string;
  /** Weekday as printed on the task cards. */
  day: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM local */
  start: string;
  end: string;
  capacity: number;
  /** Names of the people seeded as CONFIRMED in this session, in seeding order. */
  confirmed: string[];
}

export interface StudyQueueSpec {
  name: string;
  /** Session keys in preference order. */
  acceptable: string[];
}

export interface StudyWorkshopSpec {
  code: string;
  title: string;
  sessions: StudySessionSpec[];
  /** QUEUED registrations in seq order. */
  queue: StudyQueueSpec[];
}

export interface StudyState {
  track: StudyTrack;
  dataset: StudyDataset;
  workshops: StudyWorkshopSpec[];
}

function session(
  key: string,
  day: string,
  date: string,
  start: string,
  end: string,
  capacity: number,
  confirmed: string[],
): StudySessionSpec {
  return { key, day, date, start, end, capacity, confirmed };
}

const PARTICIPANT_A: StudyWorkshopSpec[] = [
  {
    code: 'W1-A',
    title: 'Data Visualisation Basics',
    sessions: [
      session('S1', 'Mon', '2026-11-16', '10:00', '11:30', 2, ['Aiden Tan', 'Priya Nair']),
      session('S2', 'Tue', '2026-11-17', '14:00', '15:30', 2, ['Marcus Lim']),
      session('S3', 'Wed', '2026-11-18', '16:00', '17:30', 2, ['Chloe Wong', 'Daniel Koh']),
    ],
    queue: [],
  },
  {
    code: 'W2-A',
    title: 'Git Basics',
    sessions: [
      session('S1', 'Thu', '2026-11-19', '10:00', '11:30', 3, [
        'Ethan Ng',
        'Grace Yeo',
        'Hafiz Rahman',
      ]),
      session('S2', 'Fri', '2026-11-20', '14:00', '15:30', 3, [
        'Isabel Cruz',
        'Jun Hao Tan',
        'Kavya Menon',
      ]),
      session('S3', 'Sat', '2026-11-21', '10:00', '11:30', 3, [
        'Leon Mueller',
        'Natalie Pang',
        'Omar Haddad',
      ]),
    ],
    queue: [
      { name: 'Wei Jie Ong', acceptable: ['S1', 'S2'] },
      { name: 'Sara Ahmed', acceptable: ['S1', 'S3'] },
    ],
  },
];

const PARTICIPANT_B: StudyWorkshopSpec[] = [
  {
    code: 'W1-B',
    title: 'Resume Clinic',
    sessions: [
      session('S1', 'Tue', '2026-11-17', '11:00', '12:30', 2, ['Bella Chen', 'Carl Ong']),
      session('S2', 'Thu', '2026-11-19', '15:00', '16:30', 2, ['Devi Pillai', 'Elliot Low']),
      session('S3', 'Fri', '2026-11-20', '10:00', '11:30', 2, ['Fiona Goh']),
    ],
    queue: [],
  },
  {
    code: 'W2-B',
    title: 'Python for Data Analysis',
    sessions: [
      session('S1', 'Mon', '2026-11-16', '09:00', '10:30', 3, [
        'Hannah Lim',
        'Ivan Petrov',
        'Jia Yi Wong',
      ]),
      session('S2', 'Wed', '2026-11-18', '13:00', '14:30', 3, [
        'Karthik Raj',
        'Lucas Tan',
        'Maya Singh',
      ]),
      session('S3', 'Thu', '2026-11-19', '17:00', '18:30', 3, [
        'Noah Koh',
        'Olivia Chan',
        'Pavel Novak',
      ]),
    ],
    queue: [
      { name: 'Qi Ling Teo', acceptable: ['S1', 'S2'] },
      { name: 'Rafael Santos', acceptable: ['S1'] },
      { name: 'Siti Nurul', acceptable: ['S1', 'S3'] },
    ],
  },
];

const ORGANISER_A: StudyWorkshopSpec[] = [
  {
    code: 'W3-A',
    title: 'Excel Power Tools',
    sessions: [
      session('S1', 'Mon', '2026-11-16', '10:00', '11:30', 3, [
        'Mei Lin Chua',
        'Ravi Shankar',
        'Tom Becker',
      ]),
      session('S2', 'Tue', '2026-11-17', '14:00', '15:30', 3, [
        'Alicia Fernandez',
        'Ben Carter',
        'Zoe Lau',
      ]),
      session('S3', 'Wed', '2026-11-18', '16:00', '17:30', 3, [
        'Nadia Rahman',
        'Kai Zhang',
        'Olivia Park',
      ]),
    ],
    queue: [
      { name: 'Hui Min Teo', acceptable: ['S1'] },
      { name: 'Yusuf Ali', acceptable: ['S1', 'S2'] },
      { name: 'Samuel Goh', acceptable: ['S3'] },
    ],
  },
];

const ORGANISER_B: StudyWorkshopSpec[] = [
  {
    code: 'W3-B',
    title: 'Public Speaking Lab',
    sessions: [
      session('S1', 'Tue', '2026-11-17', '09:00', '10:30', 3, [
        'Farah Ismail',
        'Gopal Krishnan',
        'Hana Sato',
      ]),
      session('S2', 'Thu', '2026-11-19', '13:00', '14:30', 3, [
        'Ivy Lim',
        'Jonas Weber',
        'Kiran Desai',
      ]),
      session('S3', 'Fri', '2026-11-20', '15:00', '16:30', 3, [
        'Lily Zhou',
        'Mateo Rossi',
        'Nur Aisyah',
      ]),
    ],
    queue: [
      { name: 'Oscar Lee', acceptable: ['S1'] },
      { name: 'Petra Novak', acceptable: ['S1', 'S2'] },
      { name: 'Quentin Tay', acceptable: ['S3'] },
      { name: 'Rania Said', acceptable: ['S3'] },
    ],
  },
];

const STATES: Record<StudyTrack, Record<StudyDataset, StudyWorkshopSpec[]>> = {
  participant: { A: PARTICIPANT_A, B: PARTICIPANT_B },
  organiser: { A: ORGANISER_A, B: ORGANISER_B },
};

export function studyState(track: StudyTrack, dataset: StudyDataset): StudyState {
  return { track, dataset, workshops: structuredClone(STATES[track][dataset]) };
}

/** `Mei Lin Chua` → `meilin.chua@example.com` (control-condition-setup.md §5 convention). */
export function studyEmail(name: string, domain = STUDY_EMAIL_DOMAIN): string {
  const clean = (part: string): string => part.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = name.trim().split(/\s+/);
  const last = parts.pop() ?? '';
  const first = parts.map(clean).join('');
  return `${first.length > 0 ? `${first}.` : ''}${clean(last)}@${domain}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Mon 16 Nov 10:00–11:30` — what the task cards call the session. */
export function studySessionTitle(spec: StudySessionSpec): string {
  const [, month, day] = spec.date.split('-');
  const monthName = MONTHS[Number(month) - 1] ?? month;
  return `${spec.day} ${Number(day)} ${monthName} ${spec.start}–${spec.end}`;
}

/** ISO-8601 with the Singapore offset; the API normalises it to UTC. */
export function studySessionStartsAt(spec: StudySessionSpec): string {
  return `${spec.date}T${spec.start}:00${STUDY_UTC_OFFSET}`;
}

export interface StudyPerson {
  name: string;
  email: string;
}

/** Every dummy registrant of the state, in order of first appearance (no duplicates). */
export function studyRegistrants(state: StudyState): StudyPerson[] {
  const seen = new Map<string, StudyPerson>();
  for (const workshop of state.workshops) {
    for (const spec of workshop.sessions) {
      for (const name of spec.confirmed) {
        seen.set(name, { name, email: studyEmail(name) });
      }
    }
    for (const entry of workshop.queue) {
      seen.set(entry.name, { name: entry.name, email: studyEmail(entry.name) });
    }
  }
  return [...seen.values()];
}

/** All study workshop titles (both tracks, both datasets). */
export function studyWorkshopTitles(): string[] {
  const titles = new Set<string>();
  for (const track of STUDY_TRACKS) {
    for (const dataset of STUDY_DATASETS) {
      for (const workshop of STATES[track][dataset]) {
        titles.add(workshop.title);
      }
    }
  }
  return [...titles];
}

export interface StudySessionExpectation {
  key: string;
  title: string;
  capacity: number;
  confirmed: number;
  free: number;
}

export interface StudyWorkshopExpectation {
  code: string;
  title: string;
  sessions: StudySessionExpectation[];
  /** Queue in seq order with the 1-based position the UI shows. */
  queue: { name: string; email: string; position: number; acceptable: string[] }[];
  queuedTotal: number;
  distinctConfirmed: number;
}

/** What the dashboard must show after seeding. */
export function studyExpectation(workshop: StudyWorkshopSpec): StudyWorkshopExpectation {
  return {
    code: workshop.code,
    title: workshop.title,
    sessions: workshop.sessions.map((spec) => ({
      key: spec.key,
      title: studySessionTitle(spec),
      capacity: spec.capacity,
      confirmed: spec.confirmed.length,
      free: spec.capacity - spec.confirmed.length,
    })),
    queue: workshop.queue.map((entry, index) => ({
      name: entry.name,
      email: studyEmail(entry.name),
      position: index + 1,
      acceptable: [...entry.acceptable],
    })),
    queuedTotal: workshop.queue.length,
    distinctConfirmed: new Set(workshop.sessions.flatMap((spec) => spec.confirmed)).size,
  };
}
