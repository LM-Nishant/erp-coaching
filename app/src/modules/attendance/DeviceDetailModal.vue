<template>
  <ion-modal :is-open="!!device" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ device?.name }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content v-if="device">
      <ion-list>
        <template v-if="device.protocol === 'adms'">
          <ion-list-header><ion-label>Settings on the device</ion-label></ion-list-header>
          <ion-item lines="none">
            <ion-note class="ion-text-wrap"
              >Menu → COMM. → Cloud Server Setting (ADMS on some models). Enter these values, leave the proxy
              off, then restart the device.</ion-note
            >
          </ion-item>
          <ion-item>
            <ion-label>Server address</ion-label><ion-note slot="end">{{ server.host }}</ion-note>
          </ion-item>
          <ion-item>
            <ion-label>Server port</ion-label><ion-note slot="end">{{ server.port }}</ion-note>
          </ion-item>
          <ion-item>
            <ion-label>HTTPS</ion-label><ion-note slot="end">{{ server.https ? 'On' : 'Off' }}</ion-note>
          </ion-item>
        </template>
        <template v-else>
          <ion-list-header><ion-label>Push endpoint</ion-label></ion-list-header>
          <ion-item lines="none">
            <ion-note class="ion-text-wrap"
              >The device or middleware sends punches to <code>POST {{ pushUrl }}</code> with the
              <code>X-Device-Serial</code> and <code>X-Device-Key</code> headers.</ion-note
            >
          </ion-item>
        </template>

        <ion-list-header><ion-label>Status</ion-label></ion-list-header>
        <ion-item>
          <ion-label>Serial number</ion-label><ion-note slot="end">{{ device.serial }}</ion-note>
        </ion-item>
        <ion-item>
          <ion-label>Last seen</ion-label
          ><ion-note slot="end">{{ when(device.lastSeenAt) ?? 'Never' }}</ion-note>
        </ion-item>
        <ion-item v-if="device.lastIp">
          <ion-label>Connected from</ion-label><ion-note slot="end">{{ device.lastIp }}</ion-note>
        </ion-item>
        <ion-item v-for="[label, value] in infoRows" :key="label">
          <ion-label>{{ label }}</ion-label><ion-note slot="end">{{ value }}</ion-note>
        </ion-item>
        <ion-item v-if="device.lastError">
          <ion-label color="danger" class="ion-text-wrap"
            >{{ device.lastError }}
            <p>{{ when(device.lastErrorAt) }} · saving the device clears this message</p></ion-label
          >
        </ion-item>

        <template v-if="device.protocol === 'adms'">
          <ion-list-header>
            <ion-label>Commands</ion-label>
            <ion-button @click="loadCommands">Refresh</ion-button>
          </ion-list-header>
          <ion-item lines="none">
            <ion-note class="ion-text-wrap"
              >Commands run when the device next checks in, usually within a minute while it is
              online.</ion-note
            >
          </ion-item>
          <div class="actions">
            <ion-button size="small" fill="outline" :disabled="busy" @click="send({ kind: 'sync_clock' })"
              >Sync clock</ion-button
            >
            <ion-button size="small" fill="outline" :disabled="busy" @click="send({ kind: 'device_info' })"
              >Refresh device info</ion-button
            >
            <ion-button size="small" fill="outline" :disabled="busy" @click="send({ kind: 'fetch_users' })"
              >Re-read users</ion-button
            >
            <ion-button size="small" fill="outline" :disabled="busy" @click="resendPunches"
              >Re-send punches</ion-button
            >
          </div>
          <ion-item v-for="c in commands" :key="c.id">
            <ion-label
              >{{ KIND_LABEL[c.kind] }}
              <p>
                {{ when(c.createdAt) }}
                <span v-if="c.returnCode !== null && c.returnCode !== 0">
                  · device error {{ c.returnCode }}</span
                >
              </p></ion-label
            >
            <ion-badge slot="end" :color="STATUS_COLOR[c.status]">{{ c.status }}</ion-badge>
          </ion-item>
        </template>
      </ion-list>
      <div class="actions pad">
        <ion-button fill="outline" @click="emit('edit', device)">Edit</ion-button>
        <ion-button v-if="device.protocol === 'api'" fill="outline" @click="rotate">New key</ion-button>
        <ion-button fill="outline" color="danger" @click="remove">Delete</ion-button>
      </div>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  alertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import type {
  AttendanceDeviceDto,
  DeviceCommandDto,
  DeviceCommandKind,
  DeviceCommandStatus,
} from '@erp/shared';
import { API_URL } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { admsServer, attendanceApi, localDate, type DeviceCommandInput } from './api';

const props = defineProps<{ device: AttendanceDeviceDto | null }>();
const emit = defineEmits<{ close: []; edit: [device: AttendanceDeviceDto]; changed: [] }>();

const KIND_LABEL: Record<DeviceCommandKind, string> = {
  sync_clock: 'Sync clock',
  device_info: 'Refresh device info',
  fetch_users: 'Re-read users',
  fetch_user: 'Read one user',
  fetch_logs: 'Re-send punches',
};
const STATUS_COLOR: Record<DeviceCommandStatus, string> = {
  pending: 'medium',
  sent: 'primary',
  done: 'success',
  failed: 'danger',
  expired: 'warning',
};

const server = admsServer();
const pushUrl = `${API_URL}/api/attendance/public/device-events`;
const commands = ref<DeviceCommandDto[]>([]);
const busy = ref(false);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

const infoRows = computed(() => {
  const i = props.device?.info;
  if (!i) return [];
  const rows: [string, string][] = [];
  const model = [i.vendor, i.deviceName].filter(Boolean).join(' ');
  if (model) rows.push(['Model', model]);
  if (i.firmware) rows.push(['Firmware', i.firmware]);
  if (i.pushVersion) rows.push(['Push protocol', i.pushVersion]);
  if (i.users != null) rows.push(['Users on device', String(i.users)]);
  if (i.fingerprints != null) rows.push(['Fingerprints', String(i.fingerprints)]);
  if (i.faces != null) rows.push(['Faces', String(i.faces)]);
  if (i.attLogs != null) rows.push(['Punches stored', String(i.attLogs)]);
  if (i.ip) rows.push(['Device IP', i.ip]);
  return rows;
});

async function loadCommands() {
  const d = props.device;
  if (!d || d.protocol !== 'adms') return;
  try {
    commands.value = await attendanceApi.deviceCommands(d.id);
  } catch (e) {
    await toastError(e);
  }
}

watch(
  () => props.device?.id,
  () => {
    commands.value = [];
    void loadCommands();
  },
  { immediate: true },
);

async function send(cmd: DeviceCommandInput) {
  if (!props.device) return;
  busy.value = true;
  try {
    await attendanceApi.sendDeviceCommand(props.device.id, cmd);
    await toast('Command queued');
    await loadCommands();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function resendPunches() {
  const a = await alertController.create({
    header: 'Re-send punches',
    message: 'The device uploads its punches for these days again; ones already received are skipped.',
    inputs: [
      { name: 'from', type: 'date', value: localDate(new Date(Date.now() - 7 * 86_400_000)) },
      { name: 'to', type: 'date', value: localDate() },
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Send', role: 'confirm' },
    ],
  });
  await a.present();
  const r = await a.onDidDismiss<{ values: { from: string; to: string } }>();
  const v = r.data?.values;
  if (r.role === 'confirm' && v?.from && v.to) await send({ kind: 'fetch_logs', from: v.from, to: v.to });
}

async function rotate() {
  if (!props.device) return;
  try {
    const d = await attendanceApi.rotateDeviceKey(props.device.id);
    const a = await alertController.create({
      header: 'Device API key',
      message: `Configure ${d.serial} with this key. It is shown only once: ${d.apiKey}`,
      buttons: ['Done'],
    });
    await a.present();
  } catch (e) {
    await toastError(e);
  }
}

async function remove() {
  const d = props.device;
  if (!d) return;
  const a = await alertController.create({
    header: 'Delete device?',
    message: `${d.name} (${d.serial}) will be refused from now on. Punches already received are kept.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'destructive') return;
  try {
    await attendanceApi.removeDevice(d.id);
    emit('changed');
    emit('close');
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px;
}
.pad {
  margin-bottom: 24px;
}
</style>
