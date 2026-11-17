<template>
  <AppPage title="Student settings" back-href="/students">
    <form v-if="s" @submit.prevent="save">
      <ion-list lines="full">
        <ion-list-header><ion-label>Numbering</ion-label></ion-list-header>
        <ion-item>
          <ion-input
            v-model="s.admissionNumberFormat"
            label="Admission number format"
            label-placement="stacked"
            required
            helper-text="Tokens: {YYYY} {YY} {MM} {INST} {BRANCH} {SEQ:n}. Each distinct prefix has its own counter."
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="s.rollNumberFormat"
            label="Roll number format"
            label-placement="stacked"
            required
          />
        </ion-item>
        <ion-item
          ><ion-toggle v-model="s.autoRollNumber">Auto-assign roll number on admission</ion-toggle></ion-item
        >

        <ion-list-header><ion-label>Registration &amp; guardians</ion-label></ion-list-header>
        <ion-item
          ><ion-toggle v-model="s.selfRegistrationEnabled"
            >Allow student self-registration</ion-toggle
          ></ion-item
        >
        <ion-item v-if="s.selfRegistrationEnabled && registrationLink">
          <ion-label class="ion-text-wrap">
            <p>
              Share this link: <a :href="registrationLink" target="_blank">{{ registrationLink }}</a>
            </p>
          </ion-label>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="s.defaultBranchId"
            label="Default branch for self-registration"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option :value="null">First active branch</ion-select-option>
            <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
              b.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="s.maxGuardiansPerStudent"
            type="number"
            min="1"
            max="10"
            label="Max guardians per student"
            label-placement="stacked"
          />
        </ion-item>

        <ion-list-header><ion-label>Enquiries</ion-label></ion-list-header>
        <ion-item>
          <ion-input
            v-model="sources"
            label="Enquiry sources (comma separated)"
            label-placement="stacked"
            helper-text="Lower-case keys, e.g. walk_in, website, referral"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="s.followUpReminderMinutes"
            type="number"
            min="0"
            label="Follow-up reminder lead time (minutes)"
            label-placement="stacked"
          />
        </ion-item>
      </ion-list>
      <ion-button expand="block" type="submit" :disabled="saving">Save settings</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/vue';
import type { StudentSettings } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { branchesApi, type Branch } from '@/modules/branches/api';
import { studentsApi } from './api';

const auth = useAuthStore();
const s = ref<StudentSettings | null>(null);
const sources = ref('');
const branches = ref<Branch[]>([]);
const saving = ref(false);

const registrationLink = computed(() => {
  const slug = auth.me?.institute?.slug;
  return slug ? `${window.location.origin}/register/${slug}` : null;
});

async function save() {
  saving.value = true;
  try {
    s.value = await studentsApi.saveSettings({
      ...s.value!,
      enquirySources: sources.value
        .split(',')
        .map((x) => x.trim().toLowerCase().replace(/\s+/g, '_'))
        .filter(Boolean),
    });
    sources.value = s.value.enquirySources.join(', ');
    await toast('Settings saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    s.value = await studentsApi.settings();
    sources.value = s.value.enquirySources.join(', ');
    branches.value = await branchesApi.list();
  } catch (e) {
    await toastError(e);
  }
});
</script>
