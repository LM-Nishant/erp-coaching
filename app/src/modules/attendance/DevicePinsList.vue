<template>
  <ion-list>
    <ion-list-header>
      <ion-label>Device users</ion-label>
      <ion-button @click="mapNewPin">Map a PIN</ion-button>
    </ion-list-header>
    <ion-item lines="none">
      <ion-note class="ion-text-wrap"
        >Everyone enrolled on a device has a user ID (PIN). Map each PIN to a student or an employee; recent
        punches from an unmapped PIN are applied when you map it.</ion-note
      >
    </ion-item>
    <ion-searchbar v-model="search" placeholder="Search PIN or name" :debounce="0" />
    <ion-item v-for="p in shown" :key="p.pin">
      <ion-label>
        {{ p.pin }}<span v-if="p.deviceName"> · {{ p.deviceName }}</span>
        <p>
          {{ owner(p) }}<span v-if="p.deviceIds.length"> · {{ deviceNames(p.deviceIds) }}</span>
        </p>
        <p v-if="p.unmatchedPunches">
          {{ p.unmatchedPunches }} unmatched {{ p.unmatchedPunches === 1 ? 'punch' : 'punches' }}, last
          {{ when(p.lastPunchAt) }}
        </p>
      </ion-label>
      <template v-if="!p.hidden">
        <ion-button slot="end" fill="clear" @click="openPicker(p.pin)">{{
          mapped(p) ? 'Change' : 'Map'
        }}</ion-button>
        <ion-button v-if="mapped(p)" slot="end" fill="clear" color="danger" @click="unmap(p)"
          >Unmap</ion-button
        >
      </template>
    </ion-item>
    <ion-item v-if="!filtered.length" lines="none">
      <ion-note class="ion-text-wrap">{{
        pins.length
          ? 'No PIN matches the search.'
          : 'No device users yet. They appear when a device uploads its users or punches.'
      }}</ion-note>
    </ion-item>
  </ion-list>
  <ion-button v-if="filtered.length > limit" fill="clear" expand="block" @click="limit += PAGE"
    >Show more</ion-button
  >

  <ion-modal :is-open="picking !== null" @did-dismiss="picking = null">
    <ion-header>
      <ion-toolbar>
        <ion-title>Map PIN {{ picking }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="picking = null">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-segment v-if="canMapStaff" v-model="kind">
        <ion-segment-button value="student">Student</ion-segment-button>
        <ion-segment-button value="employee">Employee</ion-segment-button>
      </ion-segment>
      <ion-searchbar
        v-model="query"
        :debounce="400"
        :placeholder="kind === 'student' ? 'Student name, admission no. or mobile' : 'Employee name or code'"
      />
      <ion-list>
        <ion-item v-for="r in results" :key="r.id" button :disabled="busy" @click="choose(r)">
          <ion-label
            >{{ r.name }}
            <p v-if="r.detail">{{ r.detail }}</p></ion-label
          >
        </ion-item>
        <ion-item v-if="query.trim() && !searching && !results.length" lines="none">
          <ion-note>No matches</ion-note>
        </ion-item>
      </ion-list>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  alertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import type {
  AttendanceDeviceDto,
  DevicePinDto,
  DevicePinTarget,
  EmployeeDto,
  Paginated,
  StudentDto,
} from '@erp/shared';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { attendanceApi } from './api';

const props = defineProps<{ pins: DevicePinDto[]; devices: AttendanceDeviceDto[] }>();
const emit = defineEmits<{ changed: [] }>();

interface Candidate {
  id: number;
  name: string;
  detail: string;
}

const PAGE = 50;
const auth = useAuthStore();
const canMapStaff = computed(() => auth.can('hr.edit') && auth.moduleEnabled('hr'));

const search = ref('');
const limit = ref(PAGE);
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.pins;
  return props.pins.filter((p) =>
    [p.pin, p.deviceName, p.student?.name, p.employee?.name].some((s) => s?.toLowerCase().includes(q)),
  );
});
const shown = computed(() => filtered.value.slice(0, limit.value));
watch(search, () => (limit.value = PAGE));

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
const mapped = (p: DevicePinDto) => !!(p.student || p.employee);
const deviceNames = (ids: number[]) =>
  ids
    .map((id) => props.devices.find((d) => d.id === id)?.name)
    .filter(Boolean)
    .join(', ');

function owner(p: DevicePinDto) {
  if (p.student) return `Student · ${p.student.name}`;
  if (p.employee) return p.employee.name ? `Employee · ${p.employee.name}` : 'Employee';
  if (p.hidden) return 'Mapped to someone outside your branches';
  return 'Not mapped';
}

async function unmap(p: DevicePinDto) {
  try {
    await attendanceApi.setDevicePin({ pin: p.pin, target: null });
    await toast(`PIN ${p.pin} unmapped`);
    emit('changed');
  } catch (e) {
    await toastError(e);
  }
}

/* ------------------------------------------------------------------ picker */

const picking = ref<string | null>(null);
const kind = ref<'student' | 'employee'>('student');
const query = ref('');
const results = ref<Candidate[]>([]);
const searching = ref(false);
const busy = ref(false);

function openPicker(pin: string) {
  kind.value = 'student';
  query.value = '';
  results.value = [];
  picking.value = pin;
}

async function mapNewPin() {
  const a = await alertController.create({
    header: 'Map a PIN',
    message: 'Enter the user ID exactly as on the device.',
    inputs: [{ name: 'pin', type: 'text', placeholder: 'e.g. 1024', attributes: { maxlength: 50 } }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Next', role: 'confirm' },
    ],
  });
  await a.present();
  const r = await a.onDidDismiss<{ values: { pin?: string } }>();
  const pin = r.data?.values.pin?.trim();
  if (r.role === 'confirm' && pin) openPicker(pin);
}

let searchSeq = 0;
async function find() {
  const q = query.value.trim();
  const seq = ++searchSeq;
  if (!q) {
    results.value = [];
    return;
  }
  searching.value = true;
  try {
    const found: Candidate[] =
      kind.value === 'student'
        ? (await api.get<Paginated<StudentDto>>('/students', { search: q, pageSize: 20 })).items
            .filter((s) => s.userId != null)
            .map((s) => ({ id: s.userId!, name: s.name, detail: s.admissionNumber }))
        : (await api.get<Paginated<EmployeeDto>>('/hr/employees', { search: q, pageSize: 20 })).items.map(
            (e) => ({
              id: e.id,
              name: e.name,
              detail: [e.employeeCode, e.biometricEnrolmentId ? `PIN ${e.biometricEnrolmentId}` : '']
                .filter(Boolean)
                .join(' · '),
            }),
          );
    if (seq === searchSeq) results.value = found;
  } catch (e) {
    if (seq === searchSeq) await toastError(e);
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}
watch([query, kind], find);

async function choose(c: Candidate) {
  const pin = picking.value;
  if (!pin) return;
  const target: DevicePinTarget =
    kind.value === 'student'
      ? { type: 'student', studentUserId: c.id }
      : { type: 'employee', employeeId: c.id };
  busy.value = true;
  try {
    const { reapplied } = await attendanceApi.setDevicePin({ pin, target });
    picking.value = null;
    const n = reapplied?.applied ?? 0;
    await toast(
      `PIN ${pin} mapped to ${c.name}${n ? `; ${n} earlier ${n === 1 ? 'punch' : 'punches'} applied` : ''}`,
    );
    emit('changed');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>
