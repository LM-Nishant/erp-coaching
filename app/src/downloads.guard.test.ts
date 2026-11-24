// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'vue/compiler-sfc';

/**
 * Guards the one download path, `core/downloads.ts`. In the Android and iOS apps a WebView ignores `<a download>` and
 * blob URLs, iOS blocks `window.open` after an await, and public folders need storage permissions or stay hidden from
 * the Files app. An ad-hoc download works in a browser but silently does nothing on a phone.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));
const HELPER = 'core/downloads.ts';
const SAVE = 'save the file with saveFile() from @/core/downloads';
const OPEN = 'open the link with openFileLink() from @/core/downloads';

const RULES = [
  { id: 'window-open', pattern: /\b(?:window|globalThis|self)\.open\s*\(/g, fix: OPEN },
  {
    id: 'download-attribute',
    pattern: /\.download\s*=(?!=)|setAttribute\(\s*['"`]download['"`]/g,
    fix: SAVE,
  },
  { id: 'object-url', pattern: /\bURL\.createObjectURL\s*\(/g, fix: SAVE },
  { id: 'public-folder', pattern: /\bDirectory\.(?:Documents|External\w*)\b/g, fix: SAVE },
];

/** Uses that are not downloads, with the reason. An entry that no longer matches anything fails the test. */
const ALLOWED: Record<string, Record<string, string>> = {
  'modules/lms/offline-store.ts': { 'object-url': 'plays a decrypted offline lecture inside the app' },
  'modules/lms/ResourceEditorPage.vue': { 'object-url': "reads a picked video's duration before the upload" },
  'modules/marketplace/api.ts': { 'object-url': "reads a picked video's duration before the upload" },
  'modules/exams/ScanPagesCropModal.vue': { 'object-url': 'previews a photo while it is cropped' },
  'modules/doubts/PhotoPicker.vue': { 'object-url': 'previews the photo attached to a doubt before sending' },
};

// @vue/compiler-core NodeTypes.
const ELEMENT = 1;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

interface TemplateNode {
  type: number;
  props?: { type: number; name: string; arg?: { content?: string } | null }[];
  children?: TemplateNode[];
  loc: { start: { line: number } };
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  fix: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Elements with a static or bound `download` attribute, such as `<a download>` or `<ion-button :download>`. */
function downloadAttributes(node: TemplateNode, found: number[] = []): number[] {
  const isDownload = (p: NonNullable<TemplateNode['props']>[number]) =>
    p.type === ATTRIBUTE
      ? p.name === 'download'
      : p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'download';
  if (node.type === ELEMENT && node.props?.some(isDownload)) found.push(node.loc.start.line);
  for (const child of node.children ?? []) downloadAttributes(child, found);
  return found;
}

function scan(file: string, source: string): Finding[] {
  const lineAt = (index: number) => source.slice(0, index).split('\n').length;
  const findings = RULES.flatMap((rule) =>
    Array.from(source.matchAll(rule.pattern), (m) => ({
      file,
      line: lineAt(m.index ?? 0),
      rule: rule.id,
      fix: rule.fix,
    })),
  );
  // Parsing every template is slow, and only a file that mentions `download` can have the attribute.
  const ast =
    file.endsWith('.vue') && source.includes('download')
      ? (parse(source, { filename: file }).descriptor.template?.ast as unknown as TemplateNode | undefined)
      : undefined;
  for (const line of ast ? downloadAttributes(ast) : [])
    findings.push({ file, line, rule: 'download-attribute', fix: `${SAVE}, or ${OPEN}` });
  return findings;
}

describe('downloads', () => {
  it('every download goes through core/downloads', () => {
    const findings = sourceFiles(SRC).flatMap((path) => {
      const file = relative(SRC, path).split(sep).join('/');
      return file === HELPER ? [] : scan(file, readFileSync(path, 'utf8'));
    });
    const offenders = findings
      .filter((f) => !ALLOWED[f.file]?.[f.rule])
      .map((f) => `${f.file}:${f.line}: ${f.fix}`);
    expect(offenders, 'these downloads do not work in the Android and iOS apps').toEqual([]);

    const stale = Object.entries(ALLOWED).flatMap(([file, rules]) =>
      Object.keys(rules)
        .filter((rule) => !findings.some((f) => f.file === file && f.rule === rule))
        .map((rule) => `${file} (${rule})`),
    );
    expect(stale, 'remove these allowlist entries: the code no longer needs them').toEqual([]);
  });

  it('flags ad-hoc downloads and nothing else', () => {
    const rules = (file: string, source: string) => scan(file, source).map((f) => f.rule);
    expect(rules('a.ts', "window.open(url, '_blank')")).toEqual(['window-open']);
    expect(rules('a.ts', 'link.download = name')).toEqual(['download-attribute']);
    expect(rules('a.ts', "link.setAttribute('download', name)")).toEqual(['download-attribute']);
    expect(rules('a.ts', 'link.href = URL.createObjectURL(blob)')).toEqual(['object-url']);
    expect(rules('a.ts', 'Filesystem.writeFile({ path, data, directory: Directory.Documents })')).toEqual([
      'public-folder',
    ]);
    expect(
      rules('a.ts', 'Filesystem.writeFile({ path, data, directory: Directory.ExternalStorage })'),
    ).toEqual(['public-folder']);
    expect(rules('a.vue', '<template><a :href="url" download>Save</a></template>')).toEqual([
      'download-attribute',
    ]);
    expect(
      rules('a.vue', '<template>\n<ion-button :href="url" :download="name">Save</ion-button></template>'),
    ).toEqual(['download-attribute']);
    expect(scan('a.ts', 'const a = 1;\n\nwindow.open(url);')[0].line).toBe(3);

    expect(rules('a.ts', "if (link.download === 'x') openFileLink(url); location.assign(url);")).toEqual([]);
    expect(rules('a.ts', 'Filesystem.writeFile({ path, data, directory: Directory.Data })')).toEqual([]);
    expect(
      rules('a.vue', '<template><a :href="url" target="_blank" rel="noopener">Open</a></template>'),
    ).toEqual([]);
  });
});
