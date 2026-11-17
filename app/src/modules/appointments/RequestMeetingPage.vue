<template>
  <AppPage title="Request a meeting" back-href="/appointments">
    <ion-list>
      <ion-item>
        <ion-select v-model="studentId" label="Child" interface="popover" placeholder="Choose">
          <ion-select-option v-for="c in children" :key="c.studentId" :value="c.studentId">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="studentId">
        <ion-select v-model="teacherUserId" label="Teacher" interface="popover" placeholder="Choose">
          <ion-select-option v-for="t in teachers" :key="t.teacherUserId" :value="t.teacherUserId">
            {{ t.name }} ({{ t.batches.map((b) => b.subject ?? b.name).join(', ') }})
          </ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="studentId && !teachers.length" lines="none">
        <ion-label class="muted ion-text-wrap">No teachers found for this child's batches.</ion-label>
      </ion-item>
    </ion-list>

    <template v-if="studentId && teacherUserId">
      <ion-list-header><ion-label>Pick a free time</ion-label></ion-list-header>
      <SlotPicker v-model="picked" :teacher-user-id="teacherUserId" :student-id="studentId" />
      <ion-list v-if="picked">
        <ion-item>
          <ion-segment v-model="mode">
            <ion-segment-button v-for="m in picked.modes" :key="m" :value="m">
              <ion-label>{{ m === 'online' ? 'Online' : 'In person' }}</ion-label>
            </ion-segment-button>
          </ion-segment>
        </ion-item>
        <ion-item v-if="mode === 'offline' && picked.location" lines="none">
          <ion-label class="muted">At {{ picked.location }}</ion-label>
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="agenda"
            label="What would you like to discuss?"
            label-placement="stacked"
            :maxlength="1000"
            auto-grow
          />
        </ion-item>
      </ion-list>
      <div class="ion-padding">
        <ion-button expand="block" :disabled="!picked || saving" @click="submit">
          Request {{ picked ? `${picked.date} ${picked.startTime}` : 'meeting' }}
        </ion-button>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/vue';
import type { AppointmentMode, AppointmentTeacherDto, AvailableSlotDto, ParentChildDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { parentPortalApi } from '@/modules/parent-portal/api';
import SlotPicker from './components/SlotPicker.vue';
import { appointmentsApi } from './api';

const route = useRoute();
const router = useRouter();
const children = ref<ParentChildDto[]>([]);
const teachers = ref<AppointmentTeacherDto[]>([]);
const studentId = ref<number | null>(route.query.studentId ? Number(route.query.studentId) : null);
const teacherUserId = ref<number | null>(null);
const picked = ref<AvailableSlotDto | null>(null);
const mode = ref<AppointmentMode>('offline');
const agenda = ref('');
const saving = ref(false);

watch(studentId, async (id) => {
  teacherUserId.value = null;
  teachers.value = [];
  if (!id) return;
  try {
    teachers.value = await appointmentsApi.teachersFor(id);
  } catch (e) {
    await toastError(e);
  }
});

watch(picked, (s) => {
  if (s && !s.modes.includes(mode.value)) mode.value = s.modes[0];
});

async function submit() {
  if (!picked.value || !studentId.value || !teacherUserId.value) return;
  saving.value = true;
  try {
    const a = await appointmentsApi.request({
      studentId: studentId.value,
      teacherUserId: teacherUserId.value,
      date: picked.value.date,
      startTime: picked.value.startTime,
      mode: mode.value,
      agenda: agenda.value || null,
    });
    await toast('Request sent. The teacher will confirm.');
    await router.replace(`/appointments/${a.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    children.value = await parentPortalApi.children();
    if (!studentId.value && children.value.length === 1) studentId.value = children.value[0].studentId;
    else if (studentId.value) teachers.value = await appointmentsApi.teachersFor(studentId.value);
  } catch (e) {
    await toastError(e);
  }
});
</script>
