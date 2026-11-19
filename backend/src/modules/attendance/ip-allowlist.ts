import { BlockList, isIP } from 'node:net';

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) as plain IPv4. */
export const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

const family = (addr: string) => (isIP(addr) === 6 ? 'ipv6' : 'ipv4');

/** An IP address or CIDR range (`203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`). */
export function isIpRule(rule: string): boolean {
  const [addr, prefix, ...rest] = rule.trim().split('/');
  const f = isIP(normalizeIp(addr));
  if (!f || rest.length) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (f === 4 ? 32 : 128));
}

/** Whether `ip` matches one of `rules`; an empty list allows every address. */
export function ipAllowed(rules: string[] | null | undefined, ip: string | undefined): boolean {
  if (!rules?.length) return true;
  const addr = ip ? normalizeIp(ip) : '';
  if (!isIP(addr)) return false;
  const list = new BlockList();
  for (const rule of rules) {
    if (!isIpRule(rule)) continue;
    const [raw, prefix] = rule.trim().split('/');
    const a = normalizeIp(raw);
    if (prefix === undefined) list.addAddress(a, family(a));
    else list.addSubnet(a, Number(prefix), family(a));
  }
  return list.check(addr, family(addr));
}
