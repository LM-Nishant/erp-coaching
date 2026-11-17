<template>
  <AppPage title="Attendance setup" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="rules">Rules</ion-segment-button>
      <ion-segment-button value="devices">Biometric</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'rules' && s">
      <ion-list>
        <ion-list-header><ion-label>Sessions &amp; methods</ion-label></ion-list-header>
        <ion-item>
          <ion-select v-model="s.mode" label="Take attendance" interface="popover">
            <ion-select-option value="class">Per class session</ion-select-option>
            <ion-select-option value="daily">Once per batch per day</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-for="m in ATTENDANCE_METHODS" :key="m">
          <ion-checkbox
            :checked="s.methods.includes(m)"
            @ion-change="toggleMethod(m, $event.detail.checked)"
            >{{ METHOD_LABEL[m] }}</ion-checkbox
          >
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="s.checkInOpensMinutes"
            type="number"
            label="Check-in opens (min before start)"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="s.checkInClosesMinutes"
            type="number"
            label="Check-in closes (min after start)"
          />
        </ion-item>
        <ion-item>
          <ion-input v-model.number="s.lateAfterMinutes" type="number" label="Late after (min)" />
        </ion-item>
        <ion-item>
          <ion-input v-model.number="s.qrRotateSeconds" type="number" label="QR rotates every (s)" />
        </ion-item>

        <ion-list-header><ion-label>Geofence</ion-label></ion-list-header>
        <ion-item>
          <ion-toggle v-model="s.requireGeofence"
            >Require students to be on campus for self check-in</ion-toggle
          >
        </ion-item>
        <ion-item v-for="b in branches" :key="b.id">
          <ion-label>
            {{ b.name }}
            <p v-if="s.geofences[b.id]">
              {{ s.geofences[b.id].lat.toFixed(5) }}, {{ s.geofences[b.id].lng.toFixed(5) }} ·
              {{ s.geofences[b.id].radiusM }} m
            </p>
            <p v-else>Not set</p>
          </ion-label>
          <ion-input
            v-if="s.geofences[b.id]"
            slot="end"
            v-model.number="s.geofences[b.id].radiusM"
            type="number"
            class="radius"
            aria-label="Radius (m)"
          />
          <ion-button slot="end" fill="clear" @click="setHere(b.id)">Use my location</ion-button>
          <ion-button
            v-if="s.geofences[b.id]"
            slot="end"
            fill="clear"
            color="danger"
            @click="delete s.geofences[b.id]"
            >Clear</ion-button
          >
        </ion-item>

        <ion-list-header><ion-label>Corrections, leave &amp; alerts</ion-label></ion-list-header>
        <ion-item>
          <ion-select v-model="s.correctionApproval" label="Correction approval" interface="popover">
            <ion-select-option value="teacher">Class teacher</ion-select-option>
            <ion-select-option value="admin">Admin only</ion-select-option>
            <ion-select-option value="auto">Automatic</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-toggle v-model="s.parentCorrections">Parents can request corrections</ion-toggle></ion-item
        >
        <ion-item>
          <ion-input v-model.number="s.correctionWindowDays" type="number" label="Correction window (days)" />
        </ion-item>
        <ion-item><ion-toggle v-model="s.absentAlerts">Alert parents when absent</ion-toggle></ion-item>

        <ion-list-header><ion-label>Percentage</ion-label></ion-list-header>
        <ion-item
          ><ion-toggle v-model="s.excludeLeaveFromTotal"
            >Exclude approved leave from total</ion-toggle
          ></ion-item
        >
        <ion-item>
          <ion-input v-model.number="s.halfDayWeight" type="number" step="0.1" label="Half day counts as" />
        </ion-item>
        <ion-item>
          <ion-input v-model.number="s.minPercentage" type="number" label="Minimum required %" />
        </ion-item>
      </ion-list>
      <ion-button expand="block" class="pad" :disabled="busy" @click="save">Save settings</ion-button>
    </template>

    <template v-if="tab === 'devices'">
      <ion-list>
        <ion-list-header>
          <ion-label>Devices</ion-label>
          <ion-button @click="addDevice">Add</ion-button>
        </ion-list-header>
        <ion-item v-for="d in devices" :key="d.id">
          <ion-label>
            {{ d.name }} <ion-note>{{ d.serial }}</ion-note>
            <p>
              {{ branchName(d.branchId) }} · last seen
              {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never' }}
            </p>
          </ion-label>
          <ion-toggle
            slot="end"
            :checked="d.active"
            aria-label="Active"
            @ion-change="toggleDevice(d, $event.detail.checked)"
          />
          <ion-button slot="end" fill="clear" @click="rotate(d)">New key</ion-button>
          <ion-button slot="end" fill="clear" color="danger" @click="removeDevice(d)">Delete</ion-button>
        </ion-item>
        <ion-item lines="none">
          <ion-note class="ion-text-wrap"
            >Devices push punches to <code>POST /api/attendance/public/device-events</code> with
            <code>X-Device-Serial</code> and <code>X-Device-Key</code> headers.</ion-note
          >
        </ion-item>

        <ion-list-header>
          <ion-label>Student enrolments</ion-label>
          <ion-button @click="addEnrolment">Map</ion-button>
        </ion-list-header>
        <ion-item v-for="e in enrolments" :key="e.id">
          <ion-label>{{ e.studentName }}</ion-label>
          <ion-note slot="end">{{ e.enrolmentId }}</ion-note>
          <ion-button slot="end" fill="clear" color="danger" @click="removeEnrolment(e.id)"
            >Remove</ion-button
          >
        </ion-item>

        <ion-list-header><ion-label>Recent punches</ion-label></ion-list-header>
        <ion-item v-for="ev in events" :key="ev.id">
          <ion-label>
            {{ ev.enrolmentId }} · {{ new Date(ev.punchedAt).toLocaleString() }}
            <p>
              {{ ev.deviceSerial }}<span v-if="ev.note"> · {{ ev.note }}</span>
            </p>
          </ion-label>
          <ion-badge slot="end" :color="ev.status === 'applied' ? 'success' : 'medium'">{{
            ev.status
          }}</ion-badge>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  alertController,
  IonBadge,
  IonButton,
  IonCheckbox,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/vue';
import {
  ATTENDANCE_METHODS,
  type AttendanceDeviceDto,
  type AttendanceMethod,
  type AttendanceSettingsDto,
  type BiometricEnrolmentDto,
  type DeviceEventDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { attendanceApi, type BranchRef } from './api';
import { currentPosition } from './scanner';

const METHOD_LABEL: Record<AttendanceMethod, string> = {
  manual: 'Teacher marks roster',
  mobile: 'Student mobile check-in',
  qr: 'Rotating QR code',
  biometric: 'Biometric devices',
};

const tab = ref<'rules' | 'devices'>('rules');
const s = ref<AttendanceSettingsDto | null>(null);
const branches = ref<BranchRef[]>([]);
const devices = ref<AttendanceDeviceDto[]>([]);
const enrolments = ref<BiometricEnrolmentDto[]>([]);
const events = ref<DeviceEventDto[]>([]);
const busy = ref(false);

const branchName = (id: number | null) =>
  id ? (branches.value.find((b) => b.id === id)?.name ?? '') : 'All branches';

function toggleMethod(m: AttendanceMethod, on: boolean) {
  if (!s.value) return;
  s.value.methods = on ? [...new Set([...s.value.methods, m])] : s.value.methods.filter((x) => x !== m);
}

async function setHere(branchId: number) {
  const pos = await currentPosition();
  if (!pos || !s.value) return toast('Location unavailable', 'warning');
  s.value.geofences[branchId] = { ...pos, radiusM: s.value.geofences[branchId]?.radiusM ?? 200 };
}

async function load() {
  try {
    if (tab.value === 'rules') {
      [s.value, branches.value] = await Promise.all([attendanceApi.settings(), attendanceApi.branches()]);
    } else {
      const [d, e, ev] = await Promise.all([
        attendanceApi.devices(),
        attendanceApi.enrolments(),
        attendanceApi.deviceEvents(),
      ]);
      devices.value = d;
      enrolments.value = e;
      events.value = ev.items;
    }
  } catch (e) {
    await toastError(e);
  }
}

async function save() {
  if (!s.value) return;
  busy.value = true;
  try {
    s.value = await attendanceApi.saveSettings(s.value);
    await toast('Settings saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function prompt(header: string, inputs: { name: string; placeholder: string }[]) {
  const a = await alertController.create({
    header,
    inputs: inputs.map((i) => ({ ...i, type: 'text' as const })),
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'OK', role: 'confirm' },
    ],
  });
  await a.present();
  const r = await a.onDidDismiss<{ values: Record<string, string> }>();
  return r.role === 'confirm' ? (r.data?.values ?? null) : null;
}

async function showKey(d: AttendanceDeviceDto) {
  const a = await alertController.create({
    header: 'Device API key',
    message: `Configure ${d.serial} with this key. It is shown only once: ${d.apiKey}`,
    buttons: ['Done'],
  });
  await a.present();
}

async function addDevice() {
  const v = await prompt('Add biometric device', [
    { name: 'name', placeholder: 'Name (e.g. Main gate)' },
    { name: 'serial', placeholder: 'Device serial' },
  ]);
  if (!v?.name || !v.serial) return;
  try {
    await showKey(await attendanceApi.createDevice({ name: v.name, serial: v.serial }));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function toggleDevice(d: AttendanceDeviceDto, active: boolean) {
  await attendanceApi.updateDevice(d.id, { active }).catch(toastError);
}
async function rotate(d: AttendanceDeviceDto) {
  try {
    await showKey(await attendanceApi.rotateDeviceKey(d.id));
  } catch (e) {
    await toastError(e);
  }
}
async function removeDevice(d: AttendanceDeviceDto) {
  await attendanceApi.removeDevice(d.id).then(load, toastError);
}

async function addEnrolment() {
  const v = await prompt('Map student to device id', [
    { name: 'search', placeholder: 'Student name or mobile' },
    { name: 'enrolmentId', placeholder: 'Enrolment id on the device' },
  ]);
  if (!v?.search || !v.enrolmentId) return;
  try {
    const found = await api.get<{ id: number; name: string }[]>('/academics/students', { search: v.search });
    if (found.length !== 1)
      return toast(found.length ? 'Several students match; be more specific' : 'No student found', 'warning');
    await attendanceApi.saveEnrolment(found[0].id, v.enrolmentId);
    await toast(`Mapped ${found[0].name}`);
    await load();
  } catch (e) {
    await toastError(e);
  }
}
async function removeEnrolment(id: number) {
  await attendanceApi.removeEnrolment(id).then(load, toastError);
}

onMounted(load);
watch(tab, load);
</script>

<style scoped>
.pad {
  margin: 12px 16px 24px;
}
.radius {
  max-width: 80px;
}
</style>
