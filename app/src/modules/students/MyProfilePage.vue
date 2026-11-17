<template>
  <AppPage title="My profile" :on-refresh="load">
    <ion-text v-if="notFound" class="muted"
      ><p>No student profile is linked to your account in this institute.</p></ion-text
    >
    <template v-if="me">
      <ion-card>
        <ion-card-header>
          <ion-card-title
            >{{ me.name }}
            <ion-badge :color="STATUS_COLORS[me.status]">{{ me.status }}</ion-badge></ion-card-title
          >
          <ion-card-subtitle>
            {{ me.admissionNumber }}<span v-if="me.rollNumber"> · Roll {{ me.rollNumber }}</span> ·
            {{ me.mobile }}
          </ion-card-subtitle>
        </ion-card-header>
        <ion-card-content>
          <p v-for="g in me.guardians" :key="g.linkId">
            {{ humanize(g.relation) }}: {{ g.name }} ({{ g.mobile }})
          </p>
        </ion-card-content>
      </ion-card>

      <form v-if="canEdit" @submit.prevent="save">
        <ion-list lines="full">
          <ion-list-header><ion-label>Personal details</ion-label></ion-list-header>
          <ion-item
            ><ion-input v-model="f.email" label="Email" label-placement="stacked" type="email"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.dateOfBirth" label="Date of birth" label-placement="stacked" type="date"
          /></ion-item>
          <ion-item>
            <ion-select v-model="f.gender" label="Gender" label-placement="stacked" interface="popover">
              <ion-select-option value="male">Male</ion-select-option>
              <ion-select-option value="female">Female</ion-select-option>
              <ion-select-option value="other">Other</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item><ion-input v-model="f.address" label="Address" label-placement="stacked" /></ion-item>
          <ion-item><ion-input v-model="f.city" label="City" label-placement="stacked" /></ion-item>
          <ion-item><ion-input v-model="f.state" label="State" label-placement="stacked" /></ion-item>
          <ion-item><ion-input v-model="f.pincode" label="Pincode" label-placement="stacked" /></ion-item>
          <ion-item
            ><ion-input v-model="f.schoolName" label="School / college" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.classGrade" label="Class / grade" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="f.targetExam" label="Target exam" label-placement="stacked"
          /></ion-item>
        </ion-list>
        <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
      </form>

      <ion-list>
        <ion-list-header><ion-label>Documents</ion-label></ion-list-header>
        <ion-item v-for="d in me.documents" :key="d.id">
          <ion-label>
            <h2>
              <a :href="d.url" target="_blank" rel="noopener">{{ d.title || d.originalName }}</a>
            </h2>
            <p>{{ humanize(d.docType) }} · {{ fmtDate(d.createdAt) }}</p>
          </ion-label>
        </ion-item>
        <ion-item v-if="!me.documents.length"
          ><ion-label class="muted">No documents uploaded.</ion-label></ion-item
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
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import DocumentUpload from './DocumentUpload.vue';
import { STATUS_COLORS, fmtDate, humanize, studentPortalApi } from './api';

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
    await toast('Profile updated');
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
    await toast('Uploaded');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
  }
}

onMounted(load);
</script>
