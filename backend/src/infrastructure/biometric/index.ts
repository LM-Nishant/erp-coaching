import { zonedDateTimeToUtc } from '../../shared/timezone';

export interface BiometricPunch {
  deviceSerial: string;
  /** Enrolment id on the device, mapped to a user by the attendance module. */
  enrolmentId: string;
  punchedAt: Date;
  direction?: 'in' | 'out';
}

export interface BiometricParseOptions {
  /** IANA zone of the device clock, used for timestamps that carry no UTC offset. */
  timeZone?: string;
}

/**
 * Biometric device adapter (spec §4.6). Adapters translate vendor payloads (push or pull) to
 * punches: the mock backs the generic punch API, `adms` parses ZKTeco/eSSL ADMS pushes (./adms).
 */
export interface BiometricAdapter {
  readonly name: string;
  parsePush(payload: unknown, opts?: BiometricParseOptions): Promise<BiometricPunch[]>;
  pullSince?(deviceSerial: string, since: Date): Promise<BiometricPunch[]>;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/;

/**
 * Device clocks usually stamp punches in local wall-clock time without an offset; those are read in
 * `timeZone` (never the server's zone). Stamps with an offset or `Z` are absolute instants.
 */
export function parsePunchTime(value: string, timeZone?: string): Date {
  const m = timeZone && typeof value === 'string' ? WALL_CLOCK.exec(value.trim()) : null;
  return m ? zonedDateTimeToUtc(m[1], m[2], timeZone!) : new Date(value);
}

export class MockBiometricAdapter implements BiometricAdapter {
  readonly name = 'mock';
  async parsePush(payload: unknown, opts: BiometricParseOptions = {}): Promise<BiometricPunch[]> {
    const rows = Array.isArray(payload) ? payload : [];
    return rows.map(
      (r: { deviceSerial: string; enrolmentId: string; punchedAt: string; direction?: 'in' | 'out' }) => ({
        ...r,
        punchedAt: parsePunchTime(r.punchedAt, opts.timeZone),
      }),
    );
  }
}

const adapter = new MockBiometricAdapter();
export const getBiometricAdapter = (): BiometricAdapter => adapter;

export * from './adms';
