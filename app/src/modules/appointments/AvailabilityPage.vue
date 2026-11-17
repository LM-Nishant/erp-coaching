<template>
  <AppPage title="Meeting availability" :on-refresh="load">
    <ion-list>
      <ion-list-header><ion-label>My slots</ion-label></ion-list-header>
      <ion-item v-for="s in slots" :key="s.id">
        <ion-label class="ion-text-wrap">
          <h2>
            {{ s.kind === 'recurring' ? `Every ${DAYS[s.dayOfWeek ?? 0]}` : s.date }} · {{ s.startTime }}–{{
              s.endTime
            }}
          </h2>
          <p>
            {{ s.slotMinutes }} min meetings · {{ modeLabel(s.mode) }}
            <span v-if="s.location"> · {{ s.location }}</span>
            <span v-if="branchName(s.branchId)"> · {{ branchName(s.branchId) }}</span>
          </p>
          <p v-if="s.effectiveFrom || s.effectiveTo" class="muted">
            {{ s.effectiveFrom ?? '…' }} → {{ s.effectiveTo ?? '…' }}
          </p>
        </ion-label>
        <ion-toggle slot="end" :checked="s.isActive" aria-label="Active" @ion-change="toggle(s)" />
        <ion-button slot="end" fill="clear" color="danger" aria-label="Delete" @click="remove(s)">
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!loading && !slots.length">
        <ion-label class="muted ion-text-wrap">
          No availability yet. Parents can only request meetings inside your slots.
        </ion-label>
      </ion-item>
    </ion-list>

    <ion-list>
      <ion-list-header><ion-label>Add availability</ion-label></ion-list-header>
      <ion-item>
        <ion-segment v-model="form.kind">
          <ion-segment-button value="recurring"><ion-label>Weekly</ion-label></ion-segment-button>
          <ion-segment-button value="one_off"><ion-label>One date</ion-label></ion-segment-button>
        </ion-segment>
      </ion-item>
      <ion-item v-if="branches.length > 1">
        <ion-select v-model="form.branchId" label="Branch" interface="popover">
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="form.kind === 'recurring'">
        <ion-select v-model="form.dayOfWeek" label="Day" interface="popover">
          <ion-select-option v-for="(d, i) in DAYS" :key="d" :value="i">{{ d }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-else>
        <ion-input v-model="form.date" type="date" label="Date" label-placement="stacked" />
      </ion-item>
      <ion-item>
        <ion-input v-model="form.startTime" type="time" label="From" label-placement="stacked" />
        <ion-input v-model="form.endTime" type="time" label="To" label-placement="stacked" />
      </ion-item>
      <ion-item>
        <ion-select v-model="form.slotMinutes" label="Meeting length" interface="popover">
          <ion-select-option v-for="m in [10, 15, 20, 30, 45, 60]" :key="m" :value="m"
            >{{ m }} min</ion-select-option
          >
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="form.mode" label="Mode" interface="popover">
          <ion-select-option value="both">Online or in person</ion-select-option>
          <ion-select-option value="online">Online only</ion-select-option>
          <ion-select-option value="offline">In person only</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="form.mode !== 'online'">
        <ion-input v-model="form.location" label="Location" label-placement="stacked" placeholder="Room 4" />
      </ion-item>
      <template v-if="form.kind === 'recurring'">
        <ion-item>
          <ion-input
            v-model="form.effectiveFrom"
            type="date"
            label="Starting (optional)"
            label-placement="stacked"
          />
          <ion-input
            v-model="form.effectiveTo"
            type="date"
            label="Until (optional)"
            label-placement="stacked"
          />
        </ion-item>
      </template>
    </ion-list>
    <div class="ion-padding">
      <ion-button expand="block" :disabled="saving" @click="save">Add slot</ion-button>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import type { AppointmentSlotDto, SlotKind, SlotMode } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { appointmentsApi, DAYS } from './api';

const auth = useAuthStore();
const branches = computed(() => auth.me?.branches ?? []);
const slots = ref<AppointmentSlotDto[]>([]);
const loading = ref(true);
const saving = ref(false);

const form = reactive({
  kind: 'recurring' as SlotKind,
  branchId: (auth.activeBranchId ?? branches.value[0]?.id ?? null) as number | null,
  dayOfWeek: 1,
  date: '',
  startTime: '16:00',
  endTime: '17:00',
  slotMinutes: 15,
  mode: 'both' as SlotMode,
  location: '',
  effectiveFrom: '',
  effectiveTo: '',
});

const modeLabel = (m: SlotMode) =>
  m === 'both' ? 'Online or in person' : m === 'online' ? 'Online' : 'In person';
const branchName = (id: number) =>
  branches.value.length > 1 ? branches.value.find((b) => b.id === id)?.name : '';

async function load() {
  loading.value = true;
  try {
    slots.value = await appointmentsApi.slots({ includeInactive: true });
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await appointmentsApi.createSlot({
      kind: form.kind,
      branchId: form.branchId ?? undefined,
      dayOfWeek: form.kind === 'recurring' ? form.dayOfWeek : null,
      date: form.kind === 'one_off' ? form.date || null : null,
      startTime: form.startTime,
      endTime: form.endTime,
      slotMinutes: form.slotMinutes,
      mode: form.mode,
      location: form.mode === 'online' ? null : form.location || null,
      effectiveFrom: form.kind === 'recurring' ? form.effectiveFrom || null : null,
      effectiveTo: form.kind === 'recurring' ? form.effectiveTo || null : null,
    });
    await toast('Availability added');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function toggle(s: AppointmentSlotDto) {
  try {
    const updated = await appointmentsApi.updateSlot(s.id, { isActive: !s.isActive });
    Object.assign(s, updated);
  } catch (e) {
    await toastError(e);
  }
}

async function remove(s: AppointmentSlotDto) {
  try {
    await appointmentsApi.deleteSlot(s.id);
    slots.value = slots.value.filter((x) => x.id !== s.id);
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
</script>
