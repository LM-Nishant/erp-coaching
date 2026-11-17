export interface BiometricPunch {
  deviceSerial: string;
  /** Enrolment id on the device, mapped to a user by the attendance module. */
  enrolmentId: string;
  punchedAt: Date;
  direction?: 'in' | 'out';
}

/**
 * Biometric device adapter (spec §4.6). Device make/protocol is still open, so only the
 * interface and a mock exist. Real adapters translate vendor payloads (push or pull) to punches.
 */
export interface BiometricAdapter {
  readonly name: string;
  parsePush(payload: unknown): Promise<BiometricPunch[]>;
  pullSince?(deviceSerial: string, since: Date): Promise<BiometricPunch[]>;
}

export class MockBiometricAdapter implements BiometricAdapter {
  readonly name = 'mock';
  async parsePush(payload: unknown): Promise<BiometricPunch[]> {
    const rows = Array.isArray(payload) ? payload : [];
    return rows.map(
      (r: { deviceSerial: string; enrolmentId: string; punchedAt: string; direction?: 'in' | 'out' }) => ({
        ...r,
        punchedAt: new Date(r.punchedAt),
      }),
    );
  }
}

const adapter = new MockBiometricAdapter();
export const getBiometricAdapter = (): BiometricAdapter => adapter;
