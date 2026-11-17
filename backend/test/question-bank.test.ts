import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';
import { parseCsv, parseXlsx } from '../src/modules/question-bank/spreadsheet';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };

/** Builds a minimal stored (uncompressed + deflated) XLSX with a single sheet using inline strings. */
function makeXlsx(rows: string[][]): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i);
  const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheet =
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) =>
              /^-?\d+(\.\d+)?$/.test(v)
                ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
                : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`,
            )
            .join('')}</row>`,
      )
      .join('') +
    '</sheetData></worksheet>';
  const files: [string, Buffer][] = [
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
    [
      'xl/workbook.xml',
      Buffer.from('<?xml version="1.0"?><workbook><sheets><sheet name="Q" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    ],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('question bank', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let branchAdmin: string;
  let teacher: string;
  let student: string;
  let zenith: string;
  let sa: string;
  let subjectId: number;
  let chapterId: number;
  let topicId: number;
  let bankId: number;
  let privateBankId: number;
  let mcqId: number;

  beforeAll(async () => {
    app = await getApp();
    [admin, branchAdmin, teacher, student, zenith, sa] = await Promise.all(
      [USERS.apexAdmin, USERS.apexBranchAdmin, USERS.apexTeacher, STUDENT, USERS.zenithAdmin, USERS.superAdmin].map(
        async (u) => (await login(u)).accessToken,
      ),
    );
    const subj = await request(app).post('/api/academics/subjects').set(bearer(admin)).send({ name: 'QB Chemistry', code: 'QBCHEM' });
    expect(subj.status).toBe(201);
    subjectId = subj.body.id;
    const ch = await request(app).post('/api/academics/chapters').set(bearer(admin)).send({ subjectId, name: 'Atomic Structure' });
    chapterId = ch.body.id;
    const tp = await request(app).post('/api/academics/topics').set(bearer(admin)).send({ chapterId, name: 'Bohr model' });
    topicId = tp.body.id;
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa));
  });

  it('lets teachers create shared banks and every question type with validation', async () => {
    const bank = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(teacher))
      .send({ name: 'Chemistry PYQ', subjectId, visibility: 'shared' });
    expect(bank.status).toBe(201);
    expect(bank.body).toMatchObject({ name: 'Chemistry PYQ', visibility: 'shared', subjectId });
    bankId = bank.body.id;

    const priv = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(teacher))
      .send({ name: 'My drafts', subjectId, visibility: 'private' });
    privateBankId = priv.body.id;

    const mcq = await request(app)
      .post(`/api/question-bank/banks/${bankId}/questions`)
      .set(bearer(teacher))
      .send({
        type: 'single',
        text: 'Which particle has a negative charge?',
        options: [
          { key: 'a', text: 'Proton' },
          { key: 'b', text: 'Electron' },
          { key: 'c', text: 'Neutron' },
        ],
        answerKey: { options: ['b'] },
        explanation: 'Electrons are negatively charged.',
        difficulty: 'easy',
        tags: ['pyq', 'basics'],
        chapterId,
        topicId,
      });
    expect(mcq.status).toBe(201);
    expect(mcq.body.answerKey.options).toEqual(['B']);
    expect(mcq.body).toMatchObject({ chapterId, topicId, chapterName: 'Atomic Structure', topicName: 'Bohr model' });
    mcqId = mcq.body.id;

    const bad = await request(app)
      .post(`/api/question-bank/banks/${bankId}/questions`)
      .set(bearer(teacher))
      .send({ type: 'single', text: 'x', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], answerKey: { options: ['A', 'B'] } });
    expect(bad.status).toBe(422);

    const bulk = await request(app)
      .post(`/api/question-bank/banks/${bankId}/questions/bulk`)
      .set(bearer(teacher))
      .send({
        questions: [
          {
            type: 'multiple',
            text: 'Which are noble gases?',
            options: [
              { key: 'A', text: 'He' },
              { key: 'B', text: 'Ne' },
              { key: 'C', text: 'O' },
            ],
            answerKey: { options: ['A', 'B'] },
          },
          { type: 'numerical', text: 'Atomic number of carbon?', answerKey: { value: 6, tolerance: 0 } },
          { type: 'true_false', text: 'Neutrons are charged.', answerKey: { value: false } },
          { type: 'descriptive', text: 'Explain Bohr postulates.', answerKey: { modelAnswer: 'Quantised orbits…', rubric: '2 marks per postulate' } },
        ],
      });
    expect(bulk.status).toBe(201);
    expect(bulk.body).toHaveLength(4);

    const list = await request(app).get(`/api/question-bank/questions?bankId=${bankId}&tag=pyq`).set(bearer(teacher));
    expect(list.status).toBe(200);
    expect(list.body.items.map((q: { id: number }) => q.id)).toEqual([mcqId]);
    const byType = await request(app).get(`/api/question-bank/questions?bankId=${bankId}&type=numerical`).set(bearer(teacher));
    expect(byType.body.total).toBe(1);
  });

  it('enforces ownership and visibility of banks', async () => {
    // Branch admin (manager) sees private banks; edits are allowed for managers.
    const all = await request(app).get('/api/question-bank/banks').set(bearer(branchAdmin));
    expect(all.body.map((b: { id: number }) => b.id)).toEqual(expect.arrayContaining([bankId, privateBankId]));
    const patched = await request(app).patch(`/api/question-bank/banks/${bankId}`).set(bearer(branchAdmin)).send({ description: 'Previous years' });
    expect(patched.status).toBe(200);

    // Deleting a non-empty bank is blocked.
    expect((await request(app).delete(`/api/question-bank/banks/${bankId}`).set(bearer(teacher))).status).toBe(409);
  });

  it('forbids students and isolates institutes', async () => {
    expect((await request(app).get('/api/question-bank/banks').set(bearer(student))).status).toBe(403);
    expect((await request(app).get(`/api/question-bank/questions/${mcqId}`).set(bearer(student))).status).toBe(403);
    expect((await request(app).get(`/api/question-bank/questions/${mcqId}`).set(bearer(zenith))).status).toBe(404);
    expect((await request(app).get(`/api/question-bank/banks/${bankId}`).set(bearer(zenith))).status).toBe(404);
    const zl = await request(app).get('/api/question-bank/banks').set(bearer(zenith));
    expect(zl.body.map((b: { id: number }) => b.id)).not.toContain(bankId);
    const zq = await request(app)
      .post(`/api/question-bank/banks/${bankId}/questions`)
      .set(bearer(zenith))
      .send({ type: 'true_false', text: 'x', answerKey: { value: true } });
    expect(zq.status).toBe(404);
    // instituteId in the body is ignored.
    const zb = await request(app).post('/api/question-bank/banks').set(bearer(zenith)).send({ name: 'Z bank', instituteId: 1 });
    expect(zb.status).toBe(201);
    expect((await request(app).get(`/api/question-bank/banks/${zb.body.id}`).set(bearer(admin))).status).toBe(404);
  });

  it('updates questions, attaches image assets and deletes', async () => {
    const up = await request(app)
      .patch(`/api/question-bank/questions/${mcqId}`)
      .set(bearer(teacher))
      .send({ difficulty: 'medium', answerKey: { options: ['B'] } });
    expect(up.status).toBe(200);
    expect(up.body.difficulty).toBe('medium');
    const shapeErr = await request(app).patch(`/api/question-bank/questions/${mcqId}`).set(bearer(teacher)).send({ answerKey: { options: ['Z'] } });
    expect(shapeErr.status).toBe(400);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const asset = await request(app)
      .post(`/api/question-bank/questions/${mcqId}/assets`)
      .set(bearer(teacher))
      .attach('file', png, { filename: 'diagram.png', contentType: 'image/png' });
    expect(asset.status).toBe(201);
    expect(asset.body.assets).toHaveLength(1);
    expect(asset.body.assets[0].url).toBeTruthy();
    const txt = await request(app)
      .post(`/api/question-bank/questions/${mcqId}/assets`)
      .set(bearer(teacher))
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(txt.status).toBe(400);
    const removed = await request(app)
      .delete(`/api/question-bank/questions/${mcqId}/assets/${asset.body.assets[0].id}`)
      .set(bearer(teacher));
    expect(removed.body.assets).toHaveLength(0);

    const tmp = await request(app)
      .post(`/api/question-bank/banks/${privateBankId}/questions`)
      .set(bearer(teacher))
      .send({ type: 'true_false', text: 'Temp', answerKey: { value: true } });
    expect((await request(app).delete(`/api/question-bank/questions/${tmp.body.id}`).set(bearer(teacher))).status).toBe(204);
  });

  it('imports questions from CSV and Excel with per-row errors, and exports CSV', async () => {
    const tpl = await request(app).get('/api/question-bank/import-template.csv').set(bearer(teacher));
    expect(tpl.status).toBe(200);
    const header = parseCsv(tpl.text)[0];
    expect(header).toContain('type');

    const col = (name: string) => header.indexOf(name);
    const row = (values: Record<string, string>) => header.map((h) => values[h] ?? '');
    const rows = [
      header,
      row({ type: 'single', text: 'H atom electrons?', option_a: '1', option_b: '2', answer: 'A', chapter: 'Atomic Structure', topic: 'Bohr model', difficulty: 'easy', tags: 'import;csv', marks: '' }),
      row({ type: 'numerical', text: 'Avogadro exponent?', answer: '23', tolerance: '0' }),
      row({ type: 'single', text: 'Broken', option_a: 'x', answer: 'C' }),
    ];
    expect(col('text')).toBeGreaterThanOrEqual(0);
    const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const imp = await request(app)
      .post(`/api/question-bank/banks/${privateBankId}/import`)
      .set(bearer(teacher))
      .attach('file', Buffer.from(csv), { filename: 'q.csv', contentType: 'text/csv' });
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBe(2);
    expect(imp.body.failed).toHaveLength(1);
    expect(imp.body.failed[0].row).toBe(4);

    const xlsx = makeXlsx([header, row({ type: 'true_false', text: 'Excel row', answer: 'true' })]);
    expect(parseXlsx(xlsx)[1]).toContain('Excel row');
    const ximp = await request(app)
      .post(`/api/question-bank/banks/${privateBankId}/import`)
      .set(bearer(teacher))
      .attach('file', xlsx, {
        filename: 'q.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(ximp.status).toBe(200);
    expect(ximp.body.created).toBe(1);

    const list = await request(app).get(`/api/question-bank/questions?bankId=${privateBankId}&tag=import`).set(bearer(teacher));
    expect(list.body.items[0]).toMatchObject({ chapterId, topicId, source: 'import' });

    const exp = await request(app).get(`/api/question-bank/banks/${privateBankId}/export.csv`).set(bearer(teacher));
    expect(exp.status).toBe(200);
    expect(exp.text).toContain('Avogadro exponent?');
    expect(exp.text).toContain('Excel row');
  });

  it('generates AI draft questions without saving them', async () => {
    const off = await request(app).post('/api/question-bank/generate').set(bearer(teacher)).send({ topic: 'Bohr model', type: 'single', count: 2 });
    expect(off.status).toBe(503);

    await request(app).put('/api/admin/ai/settings').set(bearer(sa)).send({
      provider: 'custom',
      baseUrl: 'https://ai.example.test/v1',
      model: 'mock-model',
      jsonMode: true,
      apiKey: 'sk-test-qbank-0000000000',
    });
    const content = JSON.stringify({
      questions: [
        {
          type: 'single',
          text: 'Energy of n=1 level in hydrogen?',
          options: [
            { key: 'A', text: '-13.6 eV' },
            { key: 'B', text: '-3.4 eV' },
          ],
          answerKey: { options: ['A'] },
          explanation: 'E = -13.6/n² eV',
          difficulty: 'medium',
        },
        { type: 'single', text: 'invalid, no options', answerKey: { options: ['A'] } },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }], usage: { total_tokens: 120 } }), {
        status: 200,
      }),
    );
    const gen = await request(app)
      .post('/api/question-bank/generate')
      .set(bearer(teacher))
      .send({ topicId, count: 2, type: 'single', difficulty: 'medium' });
    expect(gen.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(gen.body.drafts).toHaveLength(1);
    expect(gen.body.drafts[0]).toMatchObject({ source: 'ai', status: 'draft', type: 'single', subjectId, chapterId, topicId });
    const sentBody = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(JSON.stringify(sentBody.messages)).toContain('Bohr model');
    // Not persisted until a teacher saves it.
    const found = await request(app).get('/api/question-bank/questions?q=n%3D1%20level').set(bearer(teacher));
    expect(found.body.total).toBe(0);
    expect((await request(app).post('/api/question-bank/generate').set(bearer(student)).send({ topic: 'xx', type: 'single', count: 1 })).status).toBe(403);
  });
});
