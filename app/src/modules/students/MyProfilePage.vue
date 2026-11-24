<template>
  <AppPage :title="t('students.profile.title')" :on-refresh="load">
    <ion-text v-if="notFound" class="muted"
      ><p>{{ t('students.profile.notFound') }}</p></ion-text
    >
    <template v-if="me">
      <ion-card>
        <ion-card-header>
          <ion-card-title
            >{{ me.name }}
            <ion-badge :color="STATUS_COLORS[me.status]">{{
              t(`students.profile.status.${me.status}`)
            }}</ion-badge></ion-card-title
          >
          <ion-card-subtitle>
            {{ me.admissionNumber
            }}<span v-if="me.rollNumber"> · {{ t('students.profile.roll', { roll: me.rollNumber }) }}</span> ·
            {{ me.mobile }}
          </ion-card-subtitle>
        </ion-card-header>
        <ion-card-content>
          <p v-for="g in me.guardians" :key="g.linkId">
            {{ t(`students.profile.relation.${g.relation}`) }}: {{ g.name }} ({{ g.mobile }})
          </p>
        </ion-card-content>
      </ion-card>

      <form v-if="canEdit" @submit.prevent="save">
        <ion-list lines="full">
          <ion-list-header
            ><ion-label>{{ t('students.profile.personal') }}</ion-label></ion-list-header
          >
          <ion-item
            ><ion-input
              v-model="f.email"
              :label="t('students.profile.email')"
              label-placement="stacked"
              type="email"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="f.dateOfBirth"
              :label="t('students.profile.dateOfBirth')"
              label-placement="stacked"
              type="date"
          /></ion-item>
          <ion-item>
            <ion-select
              v-model="f.gender"
              :label="t('students.profile.gender')"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option value="male">{{ t('students.profile.genders.male') }}</ion-select-option>
              <ion-select-option value="female">{{ t('students.profile.genders.female') }}</ion-select-option>
              <ion-select-option value="other">{{ t('students.profile.genders.other') }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input v-model="f.address" :label="t('students.profile.address')" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.city" :label="t('students.profile.city')" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.state" :label="t('students.profile.state')" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.pincode" :label="t('students.profile.pincode')" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="f.schoolName"
              :label="t('students.profile.school')"
              label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="f.classGrade"
              :label="t('students.profile.classGrade')"
              label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="f.targetExam"
              :label="t('students.profile.targetExam')"
              label-placement="stacked"
          /></ion-item>
        </ion-list>
        <ion-button expand="block" type="submit" :disabled="saving">{{
          t('students.profile.save')
        }}</ion-button>
      </form>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('students.profile.documents') }}</ion-label></ion-list-header
        >
        <ion-item v-for="d in me.documents" :key="d.id">
          <ion-label>
            <h2>
              <a :href="d.url" target="_blank" rel="noopener">{{ d.title || d.originalName }}</a>
            </h2>
            <p>{{ docTypeLabel(d.docType) }} · {{ formatDate(d.createdAt) }}</p>
          </ion-label>
        </ion-item>
        <ion-item v-if="!me.documents.length"
          ><ion-label class="muted">{{ t('students.profile.noDocuments') }}</ion-label></ion-item
        >
      </ion-list>
      <div v-if="canEdit" class="ion-padding"><DocumentUpload :busy="uploading" @upload="upload" /></div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
  IonText,
} from '@ionic/vue';
import type { StudentProfileDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/core/api';
import { formatDate } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import DocumentUpload from './DocumentUpload.vue';
import { STATUS_COLORS, humanize, studentPortalApi } from './api';

const { t, te } = useI18n();
const docTypeLabel = (type: string) =>
  te(`students.profile.docType.${type}`) ? t(`students.profile.docType.${type}`) : humanize(type);
const auth = useAuthStore();
const me = ref<StudentProfileDto | null>(null);
const notFound = ref(false);
const saving = ref(false);
const uploading = ref(false);
const f = reactive({
  email: '',
  dateOfBirth: '',
  gender: null as 'male' | 'female' | 'other' | null,
  address: '',
  city: '',
  state: '',
  pincode: '',
  schoolName: '',
  classGrade: '',
  targetExam: '',
});
const canEdit = computed(() => me.value?.status === 'active' && auth.can('student-portal.edit'));
const orNull = (v: string) => (v.trim() ? v.trim() : null);

async function load() {
  try {
    me.value = await studentPortalApi.me();
    const m = me.value;
    Object.assign(f, {
      email: m.email ?? '',
      dateOfBirth: m.dateOfBirth ?? '',
      gender: m.gender,
      address: m.address ?? '',
      city: m.city ?? '',
      state: m.state ?? '',
      pincode: m.pincode ?? '',
      schoolName: m.academicInfo?.schoolName ?? '',
      classGrade: m.academicInfo?.classGrade ?? '',
      targetExam: m.academicInfo?.targetExam ?? '',
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound.value = true;
    else await toastError(e);
  }
}

async function save() {
  saving.value = true;
  try {
    await studentPortalApi.update({
      email: orNull(f.email),
      dateOfBirth: orNull(f.dateOfBirth),
      gender: f.gender,
      address: orNull(f.address),
      city: orNull(f.city),
      state: orNull(f.state),
      pincode: orNull(f.pincode),
      academicInfo: {
        ...me.value?.academicInfo,
        schoolName: orNull(f.schoolName),
        classGrade: orNull(f.classGrade),
        targetExam: orNull(f.targetExam),
      },
    });
    await toast(t('students.profile.updated'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function upload(p: { file: File; docType: string; title: string }) {
  uploading.value = true;
  try {
    await studentPortalApi.uploadDocument(p.file, p.docType, p.title || undefined);
    await toast(t('students.profile.uploaded'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
  }
}

onMounted(load);
</script>
