/**
 * The load scenarios: which endpoints each one hits, as whom, and how the requests are spread
 * over connections. Every connection gets its own request list (connection i uses
 * `lists[i % lists.length]`) and cycles through it until the scenario ends.
 */
import type autocannon from 'autocannon';
import { settings } from './env';
import { signedMediaPaths, startExamAttempts, type Persona, type World } from './fixtures';

type Request = autocannon.Request;

export interface Plan {
  lists: Request[][];
  connections: number;
  /** Total requests; when set the scenario ends after exactly this many instead of after LOAD_DURATION. */
  amount?: number;
}

export interface Scenario {
  name: string;
  summary: string;
  plan(world: World): Promise<Plan>;
}

function headers(persona?: Persona, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(persona ? { authorization: `Bearer ${persona.token}` } : {}), ...extra };
}

function get(path: string, persona: Persona, extra?: Record<string, string>): Request {
  return { method: 'GET', path: `/api${path}`, headers: headers(persona, extra) };
}

function send(
  method: 'POST' | 'PUT',
  path: string,
  persona: Persona | undefined,
  body: unknown = {},
): Request {
  return {
    method,
    path: `/api${path}`,
    headers: headers(persona, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  };
}

/** One list per connection, built from the connection index. */
function perConnection(count: number, build: (index: number) => Request[]): Request[][] {
  return Array.from({ length: count }, (_, index) => build(index));
}

function rotate<T>(items: T[], by: number): T[] {
  const shift = by % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** 256 KiB windows across the ~1 MiB sample document, like a player seeking through it. */
const RANGES = ['bytes=0-262143', 'bytes=262144-524287', 'bytes=524288-786431', 'bytes=786432-1048575'];

export const scenarios: Scenario[] = [
  {
    name: 'login',
    summary: 'POST /auth/login (password, known device): password hashing, device check, token issue',
    async plan(world) {
      const { connections } = settings;
      return {
        connections,
        lists: perConnection(connections, (i) => {
          const s = world.students[i % world.students.length];
          return [
            send('POST', '/auth/login', undefined, {
              identifier: s.mobile,
              password: s.password,
              device: s.device,
            }),
          ];
        }),
      };
    },
  },
  {
    name: 'dashboards',
    summary: 'home-screen reads of parents, students, the institute admin and the super admin',
    async plan(world) {
      const { connections } = settings;
      return {
        connections,
        lists: perConnection(connections, (i) => {
          const s = world.students[i % world.students.length];
          switch (i % 4) {
            case 0:
              return [
                get('/parent-portal/children', s.parent),
                get(`/parent-portal/children/${s.studentId}/summary`, s.parent),
              ];
            case 1:
              return [get('/attendance/me/summary', s), get('/notifications/inbox', s), get('/exams/my', s)];
            case 2:
              return [get('/subscription', world.admin), get('/notifications/inbox', world.admin)];
            default:
              return [get('/admin/dashboard', world.superAdmin)];
          }
        }),
      };
    },
  },
  {
    name: 'lists',
    summary:
      'paginated admin lists: students, batches, courses, exams, LMS resources, live classes, fee accounts',
    async plan(world) {
      const { connections } = settings;
      const lists = [
        '/students?pageSize=25',
        '/academics/batches',
        '/academics/courses',
        '/exams',
        '/lms/resources',
        '/live-classes',
        '/fees/accounts',
      ].map((path) => get(path, world.admin));
      return { connections, lists: perConnection(connections, (i) => rotate(lists, i)) };
    },
  },
  {
    name: 'lms-play',
    summary: 'POST /lms/resources/:id/play: access check and signed media URL issue',
    async plan(world) {
      const { connections } = settings;
      return {
        connections,
        lists: perConnection(connections, (i) => [
          send(
            'POST',
            `/lms/resources/${world.lmsResourceId}/play`,
            world.students[i % world.students.length],
          ),
        ]),
      };
    },
  },
  {
    name: 'lms-media',
    summary: 'GET signed media URL with Range requests (256 KiB chunks from local-disk storage)',
    async plan(world) {
      const { connections } = settings;
      // Signed URLs are short-lived (SIGNED_URL_TTL_SECONDS, 300 s by default), so they are issued now.
      const paths = await signedMediaPaths(world);
      return {
        connections,
        lists: perConnection(connections, (i) =>
          rotate(RANGES, i).map((range) => ({
            method: 'GET',
            path: paths[i % paths.length],
            headers: { range },
          })),
        ),
      };
    },
  },
  {
    name: 'live-join',
    summary: 'POST /live-classes/:id/join: membership check and room token issue for a live class',
    async plan(world) {
      const { connections } = settings;
      return {
        connections,
        lists: perConnection(connections, (i) => [
          send('POST', `/live-classes/${world.liveClassId}/join`, world.students[i % world.students.length]),
        ]),
      };
    },
  },
  {
    name: 'exam-save',
    summary: 'PUT /exams/my/attempts/:id/answers/:eqId: answer autosave during an exam',
    async plan(world) {
      const attempts = await startExamAttempts(world, 'autosave exam');
      // One attempt per connection, like one student per browser tab.
      const connections = Math.min(settings.connections, attempts.length);
      return {
        connections,
        lists: perConnection(connections, (i) => {
          const a = attempts[i];
          return a.examQuestionIds.map((eqId) =>
            send('PUT', `/exams/my/attempts/${a.attemptId}/answers/${eqId}`, a.student, {
              response: { options: ['A'] },
              visited: true,
              timeSpentSeconds: 30,
            }),
          );
        }),
      };
    },
  },
  {
    name: 'exam-submit',
    summary: 'POST /exams/my/attempts/:id/submit: every student submits at once (burst of LOAD_STUDENTS)',
    async plan(world) {
      const attempts = await startExamAttempts(world, 'submit exam');
      const connections = Math.min(settings.connections, attempts.length);
      // autocannon gives connection i ⌈amount/connections⌉ or ⌊…⌋ requests, first ones rounding up,
      // which matches dealing the attempts out round-robin: each attempt is submitted exactly once.
      return {
        connections,
        amount: attempts.length,
        lists: perConnection(connections, (i) =>
          attempts
            .filter((_, index) => index % connections === i)
            .map((a) => send('POST', `/exams/my/attempts/${a.attemptId}/submit`, a.student)),
        ),
      };
    },
  },
];
