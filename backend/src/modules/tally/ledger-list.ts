/**
 * Reads the ledgers and groups from a Tally masters export (Display More Reports > List of Accounts
 * > Export, XML (Data Interchange)). Tally's files are not always well-formed XML (system names
 * carry a `&#4;` marker, older exports are UTF-16), so this is a tolerant scanner rather than an
 * XML parser: it only looks at `<LEDGER>` / `<GROUP>` blocks and their NAME and PARENT.
 */

export interface ParsedTallyEntry {
  kind: 'ledger' | 'group';
  name: string;
  /** `null` for primary groups. */
  parent: string | null;
}

export interface ParsedLedgerList {
  ledgers: ParsedTallyEntry[];
  groups: ParsedTallyEntry[];
  /** Entries left out: names over the length limit, duplicates and entries past the cap. */
  ignored: number;
}

export const LEDGER_LIST_LIMITS = { maxEntries: 50_000, maxNameLength: 200 } as const;

/** Decodes the file whatever Tally wrote: UTF-8 (with or without BOM) or UTF-16 LE/BE. */
export function decodeTallyFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  // UTF-16 LE without a BOM: "<" followed by a zero byte.
  if (buf.length >= 4 && buf[0] === 0x3c && buf[1] === 0x00 && buf[3] === 0x00)
    return buf.subarray(0, buf.length - (buf.length % 2)).toString('utf16le');
  return buf.toString('utf8');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes entities and drops control characters (Tally's `&#4;` system-name marker). */
export function decodeTallyText(raw: string): string {
  return (
    raw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
        if (ref[0] !== '#') return NAMED[ref.toLowerCase()] ?? m;
        const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return Number.isFinite(cp) && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
          ? String.fromCodePoint(cp)
          : '';
      })
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function attr(tagAttrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagAttrs);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function inner(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i').exec(block);
  return m ? m[1] : null;
}

/** Parses a Tally masters export; anything that is not a LEDGER or GROUP master is ignored. */
export function parseTallyLedgerList(text: string): ParsedLedgerList {
  const out: ParsedLedgerList = { ledgers: [], groups: [], ignored: 0 };
  const seen = { ledger: new Set<string>(), group: new Set<string>() };
  const open = /<(LEDGER|GROUP)(\s[^<>]*?)?(\/?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    const kind = m[1].toUpperCase() === 'LEDGER' ? 'ledger' : 'group';
    let block = '';
    if (!m[3]) {
      const close = new RegExp(`</${m[1]}\\s*>`, 'gi');
      close.lastIndex = open.lastIndex;
      const end = close.exec(text);
      if (!end) break;
      block = text.slice(open.lastIndex, end.index);
      open.lastIndex = close.lastIndex;
    }
    const rawName = attr(m[2] ?? '', 'NAME') ?? inner(block, 'NAME');
    const name = rawName == null ? '' : decodeTallyText(rawName);
    if (!name) continue;
    const rawParent = inner(block, 'PARENT');
    let parent = rawParent == null ? null : decodeTallyText(rawParent);
    if (!parent || parent.toLowerCase() === 'primary') parent = null;
    const key = name.toLowerCase();
    if (
      name.length > LEDGER_LIST_LIMITS.maxNameLength ||
      (parent?.length ?? 0) > LEDGER_LIST_LIMITS.maxNameLength ||
      seen[kind].has(key) ||
      out.ledgers.length + out.groups.length >= LEDGER_LIST_LIMITS.maxEntries
    ) {
      out.ignored++;
      continue;
    }
    seen[kind].add(key);
    (kind === 'ledger' ? out.ledgers : out.groups).push({ kind, name, parent });
  }
  return out;
}
