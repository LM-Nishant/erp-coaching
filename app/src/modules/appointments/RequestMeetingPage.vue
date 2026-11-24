<template>
  <AppPage :title="t('appointments.request.title')" back-href="/appointments">
    <ion-list>
      <ion-item>
        <ion-select
          v-model="studentId"
          :label="t('appointments.request.child')"
          interface="popover"
          :placeholder="t('appointments.request.choose')"
        >
          <ion-select-option v-for="c in children" :key="c.studentId" :value="c.studentId">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="studentId">
        <ion-select
          v-model="teacherUserId"
          :label="t('appointments.request.teacher')"
          interface="popover"
          :placeholder="t('appointments.request.choose')"
        >
          <ion-select-option
            v-for="teacher in teachers"
            :key="teacher.teacherUserId"
            :value="teacher.teacherUserId"
          >
            {{ teacher.name }} ({{ teacher.batches.map((b) => b.subject ?? b.name).join(', ') }})
          </ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="studentId && !teachers.length" lines="none">
        <ion-label class="muted ion-text-wrap">{{ t('appointments.request.noTeachers') }}</ion-label>
      </ion-item>
    </ion-list>

    <template v-if="studentId && teacherUserId">
      <ion-list-header
        ><ion-label>{{ t('appointments.request.pickTime') }}</ion-label></ion-list-header
      >
      <SlotPicker v-model="picked" :teacher-user-id="teacherUserId" :student-id="studentId" />
      <ion-list v-if="picked">
        <ion-item>
          <ion-segment v-model="mode">
            <ion-segment-button v-for="m in picked.modes" :key="m" :value="m">
              <ion-label>{{ t(modeKey(m)) }}</ion-label>
            </ion-segment-button>
          </ion-segment>
        </ion-item>
        <ion-item v-if="mode === 'offline' && picked.location" lines="none">
          <ion-label class="muted">{{
            t('appointments.request.at', { location: picked.location })
          }}</ion-label>
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="agenda"
            :label="t('appointments.request.agenda')"
            label-placement="stacked"
            :maxlength="1000"
            auto-grow
          />
        </ion-item>
      </ion-list>
      <div class="ion-padding">
        <ion-button expand="block" :disabled="!picked || saving" @click="submit">
          {{
            picked
              ? t('appointments.request.submitAt', { when: slotStart(picked.date, picked.startTime) })
              : t('appointments.request.submit')
          }}
        </ion-button>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
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
import { appointmentsApi, modeKey, slotStart } from './api';

const { t } = useI18n();
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
    await toast(t('appointments.request.sent'));
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
