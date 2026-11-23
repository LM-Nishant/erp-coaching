<template>
  <ion-modal :is-open="instituteId !== null" @did-dismiss="emit('close')" @will-present="load">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ t('admin.edit.title') }}</ion-title>
        <ion-buttons slot="end"
          ><ion-button @click="emit('close')">{{ t('common.actions.close') }}</ion-button></ion-buttons
        >
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p v-if="!form" class="muted">{{ t('common.labels.loading') }}</p>
      <form v-else @submit.prevent="save">
        <p class="muted">{{ t('admin.edit.intro', { slug }) }}</p>
        <ion-list>
          <ion-item
            ><ion-input
              v-model="form.name"
              :label="t('common.labels.name')"
              label-placement="stacked"
              required
              :maxlength="150"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.contactPhone"
              :label="t('admin.edit.contactPhone')"
              label-placement="stacked"
              type="tel"
              :maxlength="20"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.contactEmail"
              :label="t('admin.edit.contactEmail')"
              label-placement="stacked"
              type="email"
          /></ion-item>
          <ion-item
            ><ion-textarea
              v-model="form.address"
              :label="t('admin.edit.address')"
              label-placement="stacked"
              auto-grow
              :maxlength="1000"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.city"
              :label="t('admin.edit.city')"
              label-placement="stacked"
              :maxlength="80"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.state"
              :label="t('admin.edit.state')"
              label-placement="stacked"
              :maxlength="80"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.registrationNumber"
              :label="t('admin.edit.registrationNumber')"
              label-placement="stacked"
              :maxlength="80"
          /></ion-item>
          <ion-item
            ><ion-input v-model="form.gstin" label="GSTIN" label-placement="stacked" :maxlength="20"
          /></ion-item>
          <ion-item v-for="c in COLOURS" :key="c.key">
            <label class="color">
              {{ t(c.label) }}
              <input
                type="color"
                :value="form[c.key] ?? c.fallback"
                @input="form[c.key] = ($event.target as HTMLInputElement).value"
              />
              <span class="muted">{{ form[c.key] ?? t('admin.edit.default') }}</span>
            </label>
            <ion-button v-if="form[c.key]" slot="end" fill="clear" size="small" @click="form[c.key] = null">{{
              t('admin.edit.useDefault')
            }}</ion-button>
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit" :disabled="busy">{{ t('common.actions.save') }}</ion-button>
      </form>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { toast, toastError } from '@/core/toast';
import { adminApi, type InstituteDetail } from '../api';

const { t } = useI18n();
const props = defineProps<{ instituteId: number | null }>();
const emit = defineEmits<{ close: []; saved: [institute: InstituteDetail] }>();

type Form = Omit<InstituteDetail, 'id' | 'slug' | 'status'>;
type ColourKey = 'primaryColor' | 'secondaryColor';
const COLOURS: { key: ColourKey; label: string; fallback: string }[] = [
  { key: 'primaryColor', label: 'admin.edit.primaryColour', fallback: '#1e5eff' },
  { key: 'secondaryColor', label: 'admin.edit.secondaryColour', fallback: '#64748b' },
];
/** Optional text fields: blank is sent as null (the API rejects an empty email). */
const OPTIONAL_TEXT = [
  'address',
  'city',
  'state',
  'registrationNumber',
  'gstin',
  'contactEmail',
  'contactPhone',
] as const;

const form = ref<Form | null>(null);
const slug = ref('');
const busy = ref(false);

async function load() {
  form.value = null;
  if (props.instituteId === null) return;
  try {
    const i = await adminApi.institute(props.instituteId);
    slug.value = i.slug;
    form.value = {
      name: i.name,
      address: i.address,
      city: i.city,
      state: i.state,
      registrationNumber: i.registrationNumber,
      gstin: i.gstin,
      contactEmail: i.contactEmail,
      contactPhone: i.contactPhone,
      primaryColor: i.primaryColor,
      secondaryColor: i.secondaryColor,
    };
  } catch (e) {
    await toastError(e);
    emit('close');
  }
}

async function save() {
  if (!form.value || props.instituteId === null) return;
  const body: Form = { ...form.value, name: String(form.value.name ?? '').trim() };
  for (const k of OPTIONAL_TEXT) body[k] = String(body[k] ?? '').trim() || null;
  if (body.name.length < 2) return void toast(t('admin.edit.enterName'), 'warning');
  if (body.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail))
    return void toast(t('admin.edit.invalidEmail'), 'warning');
  if (body.gstin) body.gstin = body.gstin.toUpperCase();
  busy.value = true;
  try {
    const saved = await adminApi.updateInstitute(props.instituteId, body);
    await toast(t('admin.edit.updated'));
    emit('saved', saved);
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.color {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
}
</style>
