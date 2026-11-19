<template>
  <ion-modal :is-open="open" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ device ? 'Edit device' : 'Add biometric device' }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-list>
        <ion-item v-if="!device">
          <ion-select
            v-model="form.protocol"
            label="Connection"
            label-placement="stacked"
            interface="popover"
          >
            <ion-select-option value="adms">ZKTeco / eSSL (ADMS push)</ion-select-option>
            <ion-select-option value="api">Other device or middleware (punch API)</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.name"
            label="Name"
            label-placement="stacked"
            placeholder="e.g. Main gate"
            :maxlength="100"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.serial"
            label="Serial number"
            label-placement="stacked"
            :maxlength="100"
            :disabled="!!device"
            :helper-text="
              protocol === 'adms'
                ? 'Exactly as on the device: System Info → Device Info → Serial Number'
                : 'Sent by the device in the X-Device-Serial header'
            "
          />
        </ion-item>
        <ion-item>
          <ion-select v-model="form.branchId" label="Branch" label-placement="stacked" interface="popover">
            <ion-select-option :value="null">All branches</ion-select-option>
            <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
              b.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <template v-if="protocol === 'adms'">
          <ion-item>
            <ion-input
              v-model="form.timeZone"
              label="Device clock time zone"
              label-placement="stacked"
              placeholder="Same as the institute"
              helper-text="Only if the device clock runs in another zone, e.g. Asia/Kolkata"
              :maxlength="64"
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="form.ipAllowlist"
              label="Allowed IP addresses"
              label-placement="stacked"
              placeholder="Any address"
              helper-text="Optional. The public IP of the site, one per line, e.g. 203.0.113.7 or 203.0.113.0/24"
              :auto-grow="true"
            />
          </ion-item>
          <ion-item>
            <ion-toggle v-model="form.allowHttp">Allow plain HTTP (firmware without HTTPS)</ion-toggle>
          </ion-item>
          <ion-item v-if="form.allowHttp" lines="none">
            <ion-note class="ion-text-wrap"
              >Punches then travel unencrypted and anyone who knows the serial number could send punches for
              this device. Prefer HTTPS firmware, or restrict the allowed IP addresses.</ion-note
            >
          </ion-item>
        </template>
      </ion-list>
      <ion-button expand="block" class="pad" :disabled="busy" @click="save">{{
        device ? 'Save' : 'Add device'
      }}</ion-button>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import type { AttendanceDeviceDto, DeviceProtocol } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { attendanceApi, type BranchRef, type DeviceSettingsInput } from './api';

const props = defineProps<{ open: boolean; device: AttendanceDeviceDto | null; branches: BranchRef[] }>();
const emit = defineEmits<{ close: []; saved: [device: AttendanceDeviceDto] }>();

const form = reactive({
  protocol: 'adms' as DeviceProtocol,
  name: '',
  serial: '',
  branchId: null as number | null,
  timeZone: '',
  ipAllowlist: '',
  allowHttp: false,
});
const busy = ref(false);
const protocol = computed(() => props.device?.protocol ?? form.protocol);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const d = props.device;
    Object.assign(form, {
      protocol: d?.protocol ?? 'adms',
      name: d?.name ?? '',
      serial: d?.serial ?? '',
      branchId: d?.branchId ?? null,
      timeZone: d?.timeZone ?? '',
      ipAllowlist: (d?.ipAllowlist ?? []).join('\n'),
      allowHttp: d?.allowHttp ?? false,
    });
  },
  { immediate: true },
);

async function save() {
  const name = form.name.trim();
  const serial = form.serial.trim();
  if (!name || !serial) return toast('Enter a name and the serial number', 'warning');
  const settings: DeviceSettingsInput = { name };
  if (!props.device || form.branchId !== props.device.branchId) settings.branchId = form.branchId;
  if (protocol.value === 'adms')
    Object.assign(settings, {
      timeZone: form.timeZone.trim() || null,
      ipAllowlist: form.ipAllowlist.split(/[\s,]+/).filter(Boolean),
      allowHttp: form.allowHttp,
    });
  busy.value = true;
  try {
    emit(
      'saved',
      props.device
        ? await attendanceApi.updateDevice(props.device.id, settings)
        : await attendanceApi.createDevice({ ...settings, name, serial, protocol: form.protocol }),
    );
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.pad {
  margin: 12px 16px 24px;
}
</style>
