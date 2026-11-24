<template>
  <AppPage :title="t('appointments.availability.title')" :on-refresh="load">
    <CalendarConnectionCard ref="calendarCard" />
    <ion-list>
      <ion-list-header
        ><ion-label>{{ t('appointments.availability.mySlots') }}</ion-label></ion-list-header
      >
      <ion-item v-for="s in slots" :key="s.id">
        <ion-label class="ion-text-wrap">
          <h2>
            {{
              s.kind === 'recurring'
                ? t('appointments.availability.every', { day: weekdayName(s.dayOfWeek ?? 0) })
                : formatDate(s.date)
            }}
            · {{ slotTimeRange(s.date ?? todayIso(), s.startTime, s.endTime) }}
          </h2>
          <p>
            {{ t('appointments.availability.meetingLength', { length: formatDuration(s.slotMinutes * 60) }) }}
            ·
            {{ t(modeKey(s.mode)) }}
            <span v-if="s.location"> · {{ s.location }}</span>
            <span v-if="branchName(s.branchId)"> · {{ branchName(s.branchId) }}</span>
          </p>
          <p v-if="s.effectiveFrom || s.effectiveTo" class="muted">
            {{ s.effectiveFrom ? formatDate(s.effectiveFrom) : '…' }} →
            {{ s.effectiveTo ? formatDate(s.effectiveTo) : '…' }}
          </p>
        </ion-label>
        <ion-toggle
          slot="end"
          :checked="s.isActive"
          :aria-label="t('common.status.active')"
          @ion-change="toggle(s)"
        />
        <ion-button
          slot="end"
          fill="clear"
          color="danger"
          :aria-label="t('common.actions.delete')"
          @click="remove(s)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
    </ion-list>
    <EmptyState
      v-if="!loading && !slots.length"
      :icon="timeOutline"
      :title="t('appointments.availability.emptyTitle')"
      :message="t('appointments.availability.emptyMessage')"
    />

    <ion-list>
      <ion-list-header
        ><ion-label>{{ t('appointments.availability.add') }}</ion-label></ion-list-header
      >
      <ion-item>
        <ion-segment v-model="form.kind">
          <ion-segment-button value="recurring"
            ><ion-label>{{ t('appointments.availability.weekly') }}</ion-label></ion-segment-button
          >
          <ion-segment-button value="one_off"
            ><ion-label>{{ t('appointments.availability.oneDate') }}</ion-label></ion-segment-button
          >
        </ion-segment>
      </ion-item>
      <ion-item v-if="branches.length > 1">
        <ion-select v-model="form.branchId" :label="t('appointments.fields.branch')" interface="popover">
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="form.kind === 'recurring'">
        <ion-select v-model="form.dayOfWeek" :label="t('appointments.availability.day')" interface="popover">
          <ion-select-option v-for="i in 7" :key="i" :value="i - 1">{{
            weekdayName(i - 1)
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-else>
        <ion-input
          v-model="form.date"
          type="date"
          :label="t('common.labels.date')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.startTime"
          type="time"
          :label="t('common.labels.from')"
          label-placement="stacked"
        />
        <ion-input
          v-model="form.endTime"
          type="time"
          :label="t('common.labels.to')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="form.slotMinutes"
          :label="t('appointments.availability.length')"
          interface="popover"
        >
          <ion-select-option v-for="m in [10, 15, 20, 30, 45, 60]" :key="m" :value="m">{{
            formatDuration(m * 60)
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="form.mode" :label="t('appointments.mode.label')" interface="popover">
          <ion-select-option value="both">{{ t('appointments.mode.both') }}</ion-select-option>
          <ion-select-option value="online">{{ t('appointments.mode.onlineOnly') }}</ion-select-option>
          <ion-select-option value="offline">{{ t('appointments.mode.offlineOnly') }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="form.mode !== 'online'">
        <ion-input
          v-model="form.location"
          :label="t('appointments.fields.location')"
          label-placement="stacked"
          :placeholder="t('appointments.availability.locationPlaceholder')"
        />
      </ion-item>
      <template v-if="form.kind === 'recurring'">
        <ion-item>
          <ion-input
            v-model="form.effectiveFrom"
            type="date"
            :label="t('appointments.availability.startingOptional')"
            label-placement="stacked"
          />
          <ion-input
            v-model="form.effectiveTo"
            type="date"
            :label="t('appointments.availability.untilOptional')"
            label-placement="stacked"
          />
        </ion-item>
      </template>
    </ion-list>
    <div class="ion-padding">
      <ion-button expand="block" :disabled="saving" @click="save">{{
        t('appointments.availability.addSlot')
      }}</ion-button>
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
import { timeOutline, trashOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { AppointmentSlotDto, SlotKind, SlotMode } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { formatDate, formatDuration } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import CalendarConnectionCard from '@/modules/calendar/components/CalendarConnectionCard.vue';
import { useAuthStore } from '@/stores/auth';
import { appointmentsApi, modeKey, slotTimeRange, todayIso, weekdayName } from './api';

const { t } = useI18n();
const auth = useAuthStore();
const branches = computed(() => auth.me?.branches ?? []);
const slots = ref<AppointmentSlotDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const calendarCard = ref<InstanceType<typeof CalendarConnectionCard> | null>(null);

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

const branchName = (id: number) =>
  branches.value.length > 1 ? branches.value.find((b) => b.id === id)?.name : '';

async function load() {
  loading.value = true;
  void calendarCard.value?.load();
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
    await toast(t('appointments.availability.added'));
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
