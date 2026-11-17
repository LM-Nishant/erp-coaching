<template>
  <AppPage title="Check in" :on-refresh="load">
    <template v-if="opts">
      <div v-if="qrEnabled" class="scan">
        <ion-button expand="block" size="large" :disabled="busy" @click="scan">
          <ion-icon slot="start" :icon="qrCodeOutline" />Scan class QR
        </ion-button>
        <video v-show="scanning" ref="video" playsinline muted />
        <ion-button v-if="scanning" fill="clear" @click="stopCamera">Cancel scan</ion-button>
        <ion-item v-if="manual">
          <ion-input v-model="token" label="Code shown on screen" label-placement="stacked" />
          <ion-button slot="end" :disabled="!token || busy" @click="submitQr(token)">Submit</ion-button>
        </ion-item>
      </div>

      <ion-list>
        <ion-list-header><ion-label>Today</ion-label></ion-list-header>
        <p v-if="!opts.items.length" class="empty">No classes today.</p>
        <ion-item v-for="it in opts.items" :key="it.classSessionId ?? `b${it.batchId}`">
          <ion-label>
            <h3>
              {{ it.batchName }}<span v-if="it.subjectName"> · {{ it.subjectName }}</span>
            </h3>
            <p v-if="it.startTime">{{ it.startTime.slice(0, 5) }}–{{ it.endTime?.slice(0, 5) }}</p>
          </ion-label>
          <ion-badge v-if="it.myStatus" slot="end" :color="STATUS_COLOR[it.myStatus]">{{
            STATUS_LABEL[it.myStatus]
          }}</ion-badge>
          <ion-button v-else-if="it.canCheckIn" slot="end" :disabled="busy" @click="mobile(it)"
            >Check in</ion-button
          >
          <ion-note v-else slot="end">{{ it.sessionStatus === 'closed' ? 'Closed' : 'Not open' }}</ion-note>
        </ion-item>
      </ion-list>
      <ion-button fill="clear" expand="block" router-link="/attendance/my">My attendance</ion-button>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
} from '@ionic/vue';
import { qrCodeOutline } from 'ionicons/icons';
import type { CheckInOptionDto, CheckInOptionsDto, CheckInResult } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { STATUS_COLOR, STATUS_LABEL, attendanceApi } from './api';
import { currentPosition, scanQr, webDetector } from './scanner';

const opts = ref<CheckInOptionsDto | null>(null);
const busy = ref(false);
const manual = ref(false);
const token = ref('');
const scanning = ref(false);
const video = ref<HTMLVideoElement | null>(null);
let stream: MediaStream | null = null;

const qrEnabled = computed(() => opts.value?.methods.includes('qr'));

async function load() {
  try {
    opts.value = await attendanceApi.checkInOptions();
  } catch (e) {
    await toastError(e);
  }
}

async function done(r: CheckInResult) {
  await toast(r.duplicate ? 'You were already marked' : `Marked ${r.status.replace('_', ' ')}`);
  await load();
}

async function submitQr(value: string) {
  busy.value = true;
  try {
    const pos = await currentPosition();
    await done(await attendanceApi.checkIn({ method: 'qr', token: value.trim(), ...(pos ?? {}) }));
    token.value = '';
    manual.value = false;
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function scan() {
  try {
    const value = await scanQr();
    if (value) return submitQr(value);
    if (value === null && !webDetector()) {
      manual.value = true;
      return;
    }
    await startCamera();
  } catch (e) {
    await toastError(e);
    manual.value = true;
  }
}

/** Web fallback: live camera + BarcodeDetector. */
async function startCamera() {
  const detector = webDetector();
  if (!detector || !navigator.mediaDevices) {
    manual.value = true;
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  scanning.value = true;
  const v = video.value!;
  v.srcObject = stream;
  await v.play();
  const loop = async () => {
    if (!scanning.value) return;
    const [hit] = await detector.detect(v).catch(() => []);
    if (hit?.rawValue) {
      stopCamera();
      await submitQr(hit.rawValue);
    } else requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function stopCamera() {
  scanning.value = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function mobile(it: CheckInOptionDto) {
  busy.value = true;
  try {
    const pos = await currentPosition();
    await done(
      await attendanceApi.checkIn({
        method: 'mobile',
        ...(it.classSessionId ? { classSessionId: it.classSessionId } : { batchId: it.batchId }),
        ...(pos ?? {}),
      }),
    );
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
onBeforeUnmount(stopCamera);
</script>

<style scoped>
.scan {
  padding: 16px;
}
video {
  width: 100%;
  max-width: 420px;
  border-radius: 8px;
  margin-top: 8px;
}
.empty {
  padding: 0 16px;
  color: var(--ion-color-medium);
}
</style>
