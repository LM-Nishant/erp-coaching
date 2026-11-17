<template>
  <AppPage title="Institute profile">
    <form v-if="form" @submit.prevent="save">
      <ion-card>
        <ion-card-header><ion-card-title>Branding</ion-card-title></ion-card-header>
        <ion-card-content>
          <div class="logo-row">
            <div class="logo-box">
              <img v-if="logoUrl" :src="logoUrl" alt="Logo" />
              <span v-else class="muted">No logo</span>
            </div>
            <div>
              <input
                ref="fileInput"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                hidden
                @change="uploadLogo"
              />
              <ion-button size="small" :disabled="uploading" @click="fileInput?.click()">{{
                uploading ? 'Uploading…' : 'Upload logo'
              }}</ion-button>
              <p class="muted small">Stored on the server; served via the institute's public logo URL.</p>
            </div>
          </div>
          <div class="colors">
            <label>Primary colour <input v-model="form.primaryColor" type="color" @input="preview" /></label>
            <label
              >Secondary colour <input v-model="form.secondaryColor" type="color" @input="preview"
            /></label>
          </div>
        </ion-card-content>
      </ion-card>

      <ion-card>
        <ion-card-header><ion-card-title>Details</ion-card-title></ion-card-header>
        <ion-list>
          <ion-item
            ><ion-input v-model="form.name" label="Institute name" label-placement="stacked" required
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.contactEmail"
              label="Contact email"
              label-placement="stacked"
              type="email"
          /></ion-item>
          <ion-item
            ><ion-input v-model="form.contactPhone" label="Contact phone" label-placement="stacked"
          /></ion-item>
          <ion-item><ion-input v-model="form.city" label="City" label-placement="stacked" /></ion-item>
          <ion-item><ion-input v-model="form.state" label="State" label-placement="stacked" /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.registrationNumber"
              label="Registration number"
              label-placement="stacked"
          /></ion-item>
          <ion-item><ion-input v-model="form.gstin" label="GSTIN" label-placement="stacked" /></ion-item>
          <ion-item
            ><ion-textarea v-model="form.address" label="Address" label-placement="stacked" auto-grow
          /></ion-item>
        </ion-list>
      </ion-card>
      <ion-button expand="block" type="submit" :disabled="saving" class="ion-margin">Save</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonInput,
  IonItem,
  IonList,
  IonTextarea,
} from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { applyBranding } from '@/core/branding';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';

interface InstituteProfile {
  name: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  registrationNumber: string | null;
  gstin: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  branding: { logoUrl: string | null };
}
type Form = Omit<InstituteProfile, 'branding'>;

const auth = useAuthStore();
const form = ref<Form | null>(null);
const logoUrl = ref<string | null>(null);
const saving = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

async function load() {
  const p = await api.get<InstituteProfile>('/institute');
  const { branding, ...rest } = p;
  logoUrl.value = branding.logoUrl;
  form.value = {
    ...rest,
    primaryColor: rest.primaryColor ?? '#3880ff',
    secondaryColor: rest.secondaryColor ?? '#5260ff',
  };
}

function preview() {
  if (form.value) applyBranding(form.value);
}

async function uploadLogo(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const uploaded = await api.upload(file, { module: 'institute' });
    await api.patch('/institute', { logoFileId: uploaded.id });
    await auth.fetchMe();
    logoUrl.value = auth.me?.institute?.logoUrl ?? uploaded.url;
    await toast('Logo updated');
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
    (ev.target as HTMLInputElement).value = '';
  }
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    const body = Object.fromEntries(Object.entries(form.value).map(([k, v]) => [k, v === '' ? null : v]));
    await api.patch('/institute', body);
    await auth.fetchMe();
    await toast('Saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(() => load().catch(toastError));
</script>

<style scoped>
.logo-row {
  display: flex;
  gap: 16px;
  align-items: center;
}
.logo-box {
  width: 96px;
  height: 96px;
  border: 1px dashed var(--ion-color-medium);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.logo-box img {
  max-width: 100%;
  max-height: 100%;
}
.colors {
  display: flex;
  gap: 24px;
  margin-top: 16px;
}
.colors label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.small {
  font-size: 12px;
}
</style>
