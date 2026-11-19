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
          <ion-input
            v-model.number="s.liveMinPercent"
            type="number"
            label="Live class: present after watching (%)"
          />
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
          <ion-button @click="openForm(null)">Add</ion-button>
        </ion-list-header>
        <ion-item v-for="d in devices" :key="d.id">
          <ion-label>
            {{ d.name }} <ion-note>{{ d.serial }}</ion-note>
            <p>
              {{ d.protocol === 'adms' ? 'ZKTeco/eSSL push' : 'Punch API' }} · {{ branchName(d.branchId) }} ·
              last seen {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never' }}
            </p>
            <p v-if="d.lastError" class="ion-text-wrap device-error">{{ d.lastError }}</p>
          </ion-label>
          <ion-toggle
            slot="end"
            :checked="d.active"
            aria-label="Active"
            @ion-change="toggleDevice(d, $event.detail.checked)"
          />
          <ion-button slot="end" fill="clear" @click="detail = d">Manage</ion-button>
        </ion-item>
        <ion-item v-if="!devices.length" lines="none">
          <ion-note class="ion-text-wrap"
            >No devices yet. Add a ZKTeco or eSSL device by its serial number, or a device or middleware that
            calls the punch API.</ion-note
          >
        </ion-item>
      </ion-list>

      <DevicePinsList :pins="pins" :devices="devices" @changed="load" />

      <ion-list>
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

      <DeviceFormModal
        :open="formOpen"
        :device="editing"
        :branches="branches"
        @close="formOpen = false"
        @saved="onSaved"
      />
      <DeviceDetailModal :device="detail" @close="detail = null" @edit="openForm" @changed="load" />
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
  type DeviceEventDto,
  type DevicePinDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { attendanceApi, type BranchRef } from './api';
import DeviceDetailModal from './DeviceDetailModal.vue';
import DeviceFormModal from './DeviceFormModal.vue';
import DevicePinsList from './DevicePinsList.vue';
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
const pins = ref<DevicePinDto[]>([]);
const events = ref<DeviceEventDto[]>([]);
const busy = ref(false);
const formOpen = ref(false);
const editing = ref<AttendanceDeviceDto | null>(null);
const detail = ref<AttendanceDeviceDto | null>(null);

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
      const [d, p, ev, b] = await Promise.all([
        attendanceApi.devices(),
        attendanceApi.devicePins(),
        attendanceApi.deviceEvents(),
        branches.value.length ? branches.value : attendanceApi.branches(),
      ]);
      devices.value = d;
      pins.value = p;
      events.value = ev.items;
      branches.value = b;
      if (detail.value) detail.value = d.find((x) => x.id === detail.value?.id) ?? null;
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

function openForm(d: AttendanceDeviceDto | null) {
  detail.value = null;
  editing.value = d;
  formOpen.value = true;
}

async function onSaved(d: AttendanceDeviceDto) {
  const created = !editing.value;
  formOpen.value = false;
  if (created && d.apiKey) {
    const a = await alertController.create({
      header: 'Device API key',
      message: `Configure ${d.serial} with this key. It is shown only once: ${d.apiKey}`,
      buttons: ['Done'],
    });
    await a.present();
  } else if (created) {
    // the detail view shows the server settings to enter on the device
    detail.value = d;
  } else {
    await toast('Device saved');
  }
  await load();
}

async function toggleDevice(d: AttendanceDeviceDto, active: boolean) {
  try {
    Object.assign(d, await attendanceApi.updateDevice(d.id, { active }));
  } catch (e) {
    await toastError(e);
  }
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
.device-error {
  color: var(--ion-color-danger);
}
</style>
