<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>{{ t('platform.storage.title') }}</ion-card-title>
      <div class="chip-row">
        <StatusChip
          :label="t('platform.storage.serving', { driver: storageLabel(dto.effectiveDriver) })"
          tone="success"
        />
        <StatusChip :label="t('platform.storage.serverDefault', { driver: storageLabel(dto.envDriver) })" />
        <StatusChip
          v-if="dto.updatedAt"
          :label="
            t(dto.active ? 'platform.storage.active' : 'platform.storage.savedInactive', {
              driver: storageLabel(dto.driver),
            })
          "
          :tone="dto.active ? 'primary' : 'medium'"
        />
      </div>
    </ion-card-header>
    <ion-card-content>
      <ion-list>
        <ion-item>
          <ion-select
            v-model="form.driver"
            :label="t('platform.storage.driver')"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option v-for="d in STORAGE_DRIVERS" :key="d" :value="d">{{
              storageLabel(d)
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <template v-if="form.driver !== 'local'">
          <ion-item
            ><ion-input
              v-model="form.bucket"
              :label="t('platform.storage.bucket')"
              label-placement="stacked"
              :maxlength="200"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.region"
              :label="t('platform.storage.region')"
              label-placement="stacked"
              :placeholder="form.driver === 'r2' ? 'auto' : 'ap-south-1'"
              :maxlength="60"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.endpoint"
              :label="
                form.driver === 'r2'
                  ? t('platform.storage.endpointRequired')
                  : t('platform.storage.endpointOptional')
              "
              label-placement="stacked"
              type="url"
              :placeholder="form.driver === 'r2' ? 'https://<account-id>.r2.cloudflarestorage.com' : ''"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.accessKeyId"
              :label="t('platform.storage.accessKeyId')"
              label-placement="stacked"
              autocomplete="off"
              :maxlength="200"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="form.secretAccessKey"
              :label="t('platform.storage.secretAccessKey')"
              label-placement="stacked"
              type="password"
              autocomplete="off"
              :placeholder="
                dto.hasSecret
                  ? t('platform.storage.secretSaved', {
                      hint: dto.secretHint ?? t('platform.storage.hidden'),
                    })
                  : ''
              "
          /></ion-item>
        </template>
        <ion-item
          ><ion-toggle v-model="form.active">{{ t('platform.storage.useForFiles') }}</ion-toggle></ion-item
        >
      </ion-list>
      <p class="muted note">
        {{ t('platform.storage.note') }}
        <template v-if="form.driver !== 'local'"> <br />{{ t('platform.storage.s3Note') }} </template>
      </p>
      <TestStatus :status="dto" :result="result" />
      <div class="actions">
        <ion-button fill="outline" :disabled="busy" @click="test">{{
          t('platform.test.connection')
        }}</ion-button>
        <ion-button :disabled="busy" @click="save">{{ t('common.actions.save') }}</ion-button>
      </div>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
} from '@erp/shared';
import StatusChip from '@/components/StatusChip.vue';
import { toast, toastError } from '@/core/toast';
import { platformApi, storageLabel } from '../api';
import TestStatus from './TestStatus.vue';

const props = defineProps<{ dto: PlatformStorageDto }>();
const emit = defineEmits<{ saved: [] }>();

const { t } = useI18n();

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
    await toast(t('platform.storage.saved'));
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
