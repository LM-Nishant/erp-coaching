<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>File storage</ion-card-title>
      <div class="chip-row">
        <ion-badge color="success">Serving files: {{ driverLabel(dto.effectiveDriver) }}</ion-badge>
        <ion-badge color="light">Server default: {{ driverLabel(dto.envDriver) }}</ion-badge>
        <ion-badge v-if="dto.updatedAt" :color="dto.active ? 'primary' : 'medium'">{{
          dto.active ? `${driverLabel(dto.driver)} active` : `${driverLabel(dto.driver)} saved, not active`
        }}</ion-badge>
      </div>
    </ion-card-header>
    <ion-card-content>
      <ion-list>
        <ion-item>
          <ion-select v-model="form.driver" label="Driver" label-placement="stacked" interface="popover">
            <ion-select-option v-for="d in STORAGE_DRIVERS" :key="d" :value="d">{{
              STORAGE_LABELS[d]
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <template v-if="form.driver !== 'local'">
          <ion-item
            ><ion-input v-model="form.bucket" label="Bucket *" label-placement="stacked" :maxlength="200"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.region"
              label="Region"
              label-placement="stacked"
              :placeholder="form.driver === 'r2' ? 'auto' : 'ap-south-1'"
              :maxlength="60"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.endpoint"
              :label="form.driver === 'r2' ? 'Endpoint *' : 'Endpoint (optional)'"
              label-placement="stacked"
              type="url"
              :placeholder="form.driver === 'r2' ? 'https://<account-id>.r2.cloudflarestorage.com' : ''"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.accessKeyId"
              label="Access key id *"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="200"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.secretAccessKey"
              label="Secret access key *"
              label-placement="stacked"
              type="password"
              autocomplete="off"
              :placeholder="dto.hasSecret ? `Saved (${dto.secretHint ?? 'hidden'}); blank keeps it` : ''"
          /></ion-item>
        </template>
        <ion-item><ion-toggle v-model="form.active">Use this storage for files</ion-toggle></ion-item>
      </ion-list>
      <p class="muted note">
        Local disk keeps files in the server's storage directory. Switching drivers doesn't copy existing
        files: move them to the new location before activating it. Without an active configuration the server
        default is used.
        <template v-if="form.driver !== 'local'">
          <br />The S3-compatible adapter isn't included in this build yet, so its connection test fails until
          it is implemented.
        </template>
      </p>
      <TestStatus :status="dto" :result="result" />
      <div class="actions">
        <ion-button fill="outline" :disabled="busy" @click="test">Test connection</ion-button>
        <ion-button :disabled="busy" @click="save">Save</ion-button>
      </div>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonInput,
  IonItem,
  IonList,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/vue';
import {
  STORAGE_DRIVERS,
  type IntegrationTestResultDto,
  type PlatformStorageDto,
  type PlatformStorageInput,
  type StorageDriverKey,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { STORAGE_LABELS, platformApi } from '../api';
import TestStatus from './TestStatus.vue';

const props = defineProps<{ dto: PlatformStorageDto }>();
const emit = defineEmits<{ saved: [] }>();

const driverLabel = (d: string) => STORAGE_LABELS[d as StorageDriverKey] ?? d;

const toForm = (d: PlatformStorageDto) => ({
  driver: d.driver,
  active: d.active,
  bucket: d.bucket ?? '',
  region: d.region ?? '',
  endpoint: d.endpoint ?? '',
  accessKeyId: d.accessKeyId ?? '',
  secretAccessKey: '',
});

const form = ref(toForm(props.dto));
const result = ref<IntegrationTestResultDto | null>(null);
const busy = ref(false);

watch(
  () => JSON.stringify(props.dto),
  () => {
    form.value = toForm(props.dto);
    result.value = null;
  },
);

const text = (v: unknown) => String(v ?? '').trim();

/** Connection fields as typed; a blank secret keeps the saved one. */
function connection(): Omit<PlatformStorageInput, 'active'> {
  const f = form.value;
  return {
    driver: f.driver,
    bucket: text(f.bucket) || null,
    region: text(f.region) || null,
    endpoint: text(f.endpoint) || null,
    accessKeyId: text(f.accessKeyId) || null,
    secretAccessKey: text(f.secretAccessKey) || undefined,
  };
}

async function test() {
  busy.value = true;
  try {
    result.value = await platformApi.testStorage(connection());
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function save() {
  busy.value = true;
  try {
    await platformApi.saveStorage({ ...connection(), active: form.value.active });
    await toast('Storage settings saved');
    emit('saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.chip-row {
  margin-top: 6px;
}
.note {
  font-size: 13px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
