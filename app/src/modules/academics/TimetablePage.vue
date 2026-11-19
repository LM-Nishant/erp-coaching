<template>
  <AppPage title="Timetable" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.create'" @click="gen = { from: isoToday(), to: addDays(isoToday(), 27) }"
        >Generate</ion-button
      >
      <ion-button v-can="'academics.create'" aria-label="New weekly slot" @click="openSchedule()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-item lines="none">
      <ion-select v-model="batchId" label="Batch" interface="popover" @ion-change="load">
        <ion-select-option :value="null">All batches</ion-select-option>
        <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
      </ion-select>
    </ion-item>
    <ion-segment v-model="tab">
      <ion-segment-button value="weekly"><ion-label>Weekly slots</ion-label></ion-segment-button>
      <ion-segment-button value="classes"><ion-label>Classes</ion-label></ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'weekly'">
      <ion-list v-for="(day, d) in DAYS" :key="day">
        <ion-list-header v-if="slotsByDay[d].length">{{ day }}</ion-list-header>
        <ion-item v-for="s in slotsByDay[d]" :key="s.id">
          <ion-label>
            <h3>{{ s.startTime }}–{{ s.endTime }} · {{ batchName(s.batchId) }}</h3>
            <p>
              {{ subjectName(s.subjectId) || 'Any subject' }} · {{ teacherName(s.teacherUserId) }} ·
              {{ roomName(s.classroomId) || 'No room' }}
            </p>
            <p>from {{ s.effectiveFrom }}{{ s.effectiveTo ? ` to ${s.effectiveTo}` : '' }}</p>
          </ion-label>
          <ion-button
            slot="end"
            v-can="'academics.edit'"
            fill="clear"
            aria-label="Edit slot"
            @click="openSchedule(s)"
            ><ion-icon slot="icon-only" :icon="createOutline"
          /></ion-button>
          <ion-button
            slot="end"
            v-can="'academics.delete'"
            fill="clear"
            color="danger"
            aria-label="Delete slot"
            @click="removeSchedule(s)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
      </ion-list>
      <p v-if="!loading && !schedules.length" class="muted ion-padding">No recurring slots yet.</p>
    </template>

    <template v-else>
      <ion-item lines="none">
        <ion-input v-model="range.from" type="date" label="From" @ion-change="loadClasses" />
        <ion-input v-model="range.to" type="date" label="To" @ion-change="loadClasses" />
      </ion-item>
      <ion-list>
        <ion-item
          v-for="c in classes"
          :key="c.id"
          :router-link="`/academics/classes/${c.id}`"
          :detail="false"
        >
          <ion-label>
            <h3>
              {{ weekdayOf(c.date) }} {{ c.date }} · {{ c.startTime }}–{{ c.endTime }}
              <ion-badge :color="statusColor(c.status)">{{ c.status }}</ion-badge>
              <ion-badge v-if="c.originalTeacherUserId" color="warning">substitute</ion-badge>
              <ion-badge v-if="c.rescheduledFrom" color="tertiary">rescheduled</ion-badge>
            </h3>
            <p>
              {{ c.batch?.name }} · {{ c.subject?.name ?? 'Any subject' }} · {{ c.teacher?.name }} ·
              {{ c.classroom?.name ?? 'No room' }}
            </p>
          </ion-label>
          <template v-if="c.status === 'scheduled'">
            <ion-button
              slot="end"
              v-can="'academics.edit'"
              fill="clear"
              @click.prevent.stop="openReschedule(c)"
              >Reschedule</ion-button
            >
            <ion-button
              slot="end"
              v-can="'academics.edit'"
              fill="clear"
              @click.prevent.stop="openSubstitute(c)"
              >Substitute</ion-button
            >
            <ion-button
              slot="end"
              v-can="'academics.edit'"
              fill="clear"
              color="danger"
              @click.prevent.stop="cancel(c)"
              >Cancel</ion-button
            >
          </template>
        </ion-item>
        <ion-item v-if="!classes.length"
          ><ion-label class="muted">No classes in this range.</ion-label></ion-item
        >
      </ion-list>
    </template>

    <ion-modal :is-open="!!slot" @did-dismiss="slot = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ slotId ? 'Edit slot' : 'New weekly slot' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="slot = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="slot" @submit.prevent="saveSchedule">
          <ion-list>
            <ion-item>
              <ion-select v-model="slot.batchId" label="Batch" label-placement="stacked">
                <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="slot.subjectId" label="Subject" label-placement="stacked">
                <ion-select-option :value="null">Any</ion-select-option>
                <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="slot.teacherUserId" label="Teacher" label-placement="stacked">
                <ion-select-option v-for="t in teachers" :key="t.id" :value="t.id">{{
                  t.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="slot.classroomId" label="Classroom" label-placement="stacked">
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="r in slotRooms" :key="r.id" :value="r.id"
                  >{{ r.name }} ({{ r.capacity }})</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="slot.dayOfWeek" label="Day" label-placement="stacked">
                <ion-select-option v-for="(d, i) in DAYS" :key="d" :value="i">{{ d }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input
                v-model="slot.startTime"
                type="time"
                label="Start"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="slot.endTime" type="time" label="End" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="slot.effectiveFrom"
                type="date"
                label="Effective from"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="slot.effectiveTo"
                type="date"
                label="Effective to"
                label-placement="stacked"
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!gen" @did-dismiss="gen = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Generate classes</ion-title>
          <ion-buttons slot="end"><ion-button @click="gen = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <p class="muted">
          Creates class sessions from the weekly slots{{ batchId ? ` of ${batchName(batchId)}` : '' }}.
          Existing classes are kept.
        </p>
        <ion-list v-if="gen">
          <ion-item
            ><ion-input v-model="gen.from" type="date" label="From" label-placement="stacked"
          /></ion-item>
          <ion-item><ion-input v-model="gen.to" type="date" label="To" label-placement="stacked" /></ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving" @click="generate">Generate</ion-button>
        <ion-list v-if="genResult?.conflicts.length">
          <ion-list-header>Skipped due to conflicts</ion-list-header>
          <ion-item v-for="c in genResult.conflicts" :key="`${c.scheduleId}-${c.date}`">
            <ion-label>{{ c.date }} · {{ c.reason }}</ion-label>
          </ion-item>
        </ion-list>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!resched" @did-dismiss="resched = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Reschedule class</ion-title>
          <ion-buttons slot="end"><ion-button @click="resched = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="resched" @submit.prevent="saveReschedule">
          <ion-list>
            <ion-item
              ><ion-input v-model="resched.date" type="date" label="Date" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="resched.startTime"
                type="time"
                label="Start"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="resched.endTime"
                type="time"
                label="End"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item>
              <ion-select v-model="resched.classroomId" label="Classroom" label-placement="stacked">
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="r in rooms" :key="r.id" :value="r.id">{{
                  r.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="resched.reason" label="Reason" label-placement="stacked"
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Reschedule &amp; notify</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!sub" @did-dismiss="sub = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Substitute teacher</ion-title>
          <ion-buttons slot="end"><ion-button @click="sub = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ion-list v-if="sub">
          <ion-item>
            <ion-select v-model="sub.teacherUserId" label="Teacher" label-placement="stacked">
              <ion-select-option
                v-for="t in teachers.filter((x) => x.id !== sub?.cls.teacherUserId)"
                :key="t.id"
                :value="t.id"
                >{{ t.name }}</ion-select-option
              >
            </ion-select>
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="!sub?.teacherUserId || saving" @click="saveSubstitute"
          >Assign &amp; notify</ion-button
        >
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type {
  BatchDto,
  ClassroomDto,
  ClassSessionDto,
  GenerateSessionsResult,
  ScheduleDto,
  SubjectDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { DAYS, academicsApi, addDays, isoToday, statusColor, weekdayOf, type PersonRef } from './api';

interface SlotForm {
  batchId: number | null;
  subjectId: number | null;
  teacherUserId: number | null;
  classroomId: number | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo: string;
}

const tab = ref<'weekly' | 'classes'>('weekly');
const batchId = ref<number | null>(null);
const batches = ref<BatchDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const teachers = ref<PersonRef[]>([]);
const rooms = ref<ClassroomDto[]>([]);
const schedules = ref<ScheduleDto[]>([]);
const classes = ref<ClassSessionDto[]>([]);
const range = reactive({ from: isoToday(), to: addDays(isoToday(), 13) });
const loading = ref(true);
const saving = ref(false);
const slot = ref<SlotForm | null>(null);
const slotId = ref<number | null>(null);
const gen = ref<{ from: string; to: string } | null>(null);
const genResult = ref<GenerateSessionsResult | null>(null);
const resched = ref<{
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  classroomId: number | null;
  reason: string;
} | null>(null);
const sub = ref<{ cls: ClassSessionDto; teacherUserId: number | null } | null>(null);

const name = <T extends { id: number; name: string }>(list: T[], id: number | null) =>
  id ? (list.find((x) => x.id === id)?.name ?? `#${id}`) : '';
const batchName = (id: number) => name(batches.value, id);
const subjectName = (id: number | null) => name(subjects.value, id);
const teacherName = (id: number) => name(teachers.value, id);
const roomName = (id: number | null) => name(rooms.value, id);
const slotsByDay = computed(() => DAYS.map((_, d) => schedules.value.filter((s) => s.dayOfWeek === d)));
const slotRooms = computed(() => {
  const b = batches.value.find((x) => x.id === slot.value?.batchId);
  return b ? rooms.value.filter((r) => r.branchId === b.branchId || r.isVirtual) : rooms.value;
});

async function loadClasses() {
  classes.value = (await academicsApi.classSessions({ ...range, batchId: batchId.value })).items;
}

async function load() {
  loading.value = true;
  try {
    const [bs, subs, ts, rs, ss] = await Promise.all([
      academicsApi.batches(),
      academicsApi.subjects(),
      academicsApi.teachers(),
      academicsApi.classrooms({ status: 'active' }),
      academicsApi.schedules({ batchId: batchId.value }),
    ]);
    batches.value = bs.items;
    subjects.value = subs;
    teachers.value = ts;
    rooms.value = rs;
    schedules.value = ss;
    await loadClasses();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openSchedule(s?: ScheduleDto) {
  slotId.value = s?.id ?? null;
  slot.value = {
    batchId: s?.batchId ?? batchId.value,
    subjectId: s?.subjectId ?? null,
    teacherUserId: s?.teacherUserId ?? null,
    classroomId: s?.classroomId ?? null,
    dayOfWeek: s?.dayOfWeek ?? 1,
    startTime: s?.startTime ?? '09:00',
    endTime: s?.endTime ?? '10:00',
    effectiveFrom: s?.effectiveFrom ?? isoToday(),
    effectiveTo: s?.effectiveTo ?? '',
  };
}

async function saveSchedule() {
  if (!slot.value) return;
  saving.value = true;
  try {
    await academicsApi.saveSchedule(
      { ...slot.value, effectiveTo: slot.value.effectiveTo || null },
      slotId.value ?? undefined,
    );
    slot.value = null;
    await toast('Slot saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function removeSchedule(s: ScheduleDto) {
  const alert = await alertController.create({
    header: 'Delete this weekly slot?',
    message: 'Future scheduled classes from this slot are removed; past classes are kept.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => academicsApi.removeSchedule(s.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function generate() {
  if (!gen.value) return;
  saving.value = true;
  try {
    genResult.value = await academicsApi.generate({ ...gen.value, batchId: batchId.value ?? undefined });
    await toast(
      `Created ${genResult.value.created} class(es)${genResult.value.conflicts.length ? `, ${genResult.value.conflicts.length} conflict(s)` : ''}`,
      genResult.value.conflicts.length ? 'warning' : 'success',
    );
    if (!genResult.value.conflicts.length) gen.value = null;
    await loadClasses();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

function openReschedule(c: ClassSessionDto) {
  resched.value = {
    id: c.id,
    date: c.date,
    startTime: c.startTime,
    endTime: c.endTime,
    classroomId: c.classroomId,
    reason: '',
  };
}

async function saveReschedule() {
  if (!resched.value) return;
  saving.value = true;
  try {
    const { id, reason, ...body } = resched.value;
    await academicsApi.reschedule(id, { ...body, reason: reason || undefined });
    resched.value = null;
    await toast('Class rescheduled; participants notified');
    await loadClasses();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

function openSubstitute(c: ClassSessionDto) {
  sub.value = { cls: c, teacherUserId: null };
}

async function saveSubstitute() {
  if (!sub.value?.teacherUserId) return;
  saving.value = true;
  try {
    await academicsApi.substitute(sub.value.cls.id, sub.value.teacherUserId);
    sub.value = null;
    await toast('Substitute assigned; participants notified');
    await loadClasses();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function cancel(c: ClassSessionDto) {
  const alert = await alertController.create({
    header: 'Cancel class?',
    inputs: [{ name: 'reason', placeholder: 'Reason (sent to students)' }],
    buttons: [
      { text: 'Back', role: 'cancel' },
      { text: 'Cancel class', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { reason: string } }>();
  if (role !== 'confirm') return;
  try {
    await academicsApi.cancel(c.id, data?.values.reason || 'Cancelled');
    await toast('Class cancelled; participants notified');
    await loadClasses();
  } catch (e) {
    await toastError(e);
  }
}

watch(tab, () => tab.value === 'classes' && loadClasses().catch(toastError));
onMounted(load);
</script>
