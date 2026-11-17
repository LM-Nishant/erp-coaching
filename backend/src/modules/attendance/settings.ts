import { ATTENDANCE_METHODS, type AttendanceSettingsDto } from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { AttendanceSettings } from './models';

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettingsDto = {
  mode: 'class',
  methods: ['manual', 'mobile', 'qr', 'biometric'],
  lateAfterMinutes: 10,
  checkInOpensMinutes: 15,
  checkInClosesMinutes: 30,
  qrRotateSeconds: 30,
  requireGeofence: false,
  geofences: {},
  correctionApproval: 'teacher',
  parentCorrections: true,
  correctionWindowDays: 7,
  absentAlerts: true,
  excludeLeaveFromTotal: true,
  halfDayWeight: 0.5,
  minPercentage: 75,
  liveMinPercent: 50,
};

const settingsRepo = new TenantRepository(AttendanceSettings, { entity: 'Attendance settings' });

export async function getAttendanceSettings(): Promise<AttendanceSettingsDto> {
  const row = await settingsRepo.findOne();
  const s = { ...DEFAULT_ATTENDANCE_SETTINGS, ...(row?.settings ?? {}) };
  s.methods = s.methods.filter((m) => (ATTENDANCE_METHODS as readonly string[]).includes(m));
  return s;
}

export async function updateAttendanceSettings(
  patch: Partial<AttendanceSettingsDto>,
): Promise<{ before: AttendanceSettingsDto; after: AttendanceSettingsDto }> {
  const before = await getAttendanceSettings();
  const after = { ...before, ...patch };
  const row = await settingsRepo.findOne();
  if (row) await row.update({ settings: after });
  else await settingsRepo.create({ settings: after });
  return { before, after };
}
