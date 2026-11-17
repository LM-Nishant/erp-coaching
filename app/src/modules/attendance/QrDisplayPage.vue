<template>
  <AppPage title="Attendance QR" :back-href="`/attendance/sessions/${id}`">
    <div class="qr">
      <canvas ref="canvas" />
      <p v-if="qr">Refreshes in {{ remaining }}s · students scan with “Check in”</p>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import QRCode from 'qrcode';
import type { QrTokenDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { errorMessage } from '@/core/api';
import { attendanceApi } from './api';

const route = useRoute();
const id = Number(route.params.id);
const canvas = ref<HTMLCanvasElement | null>(null);
const qr = ref<QrTokenDto | null>(null);
const remaining = ref(0);
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    qr.value = await attendanceApi.qr(id);
    error.value = '';
    if (canvas.value)
      await QRCode.toCanvas(canvas.value, qr.value.token, {
        width: Math.min(window.innerWidth - 48, 420),
        margin: 2,
        errorCorrectionLevel: 'M',
      });
  } catch (e) {
    error.value = errorMessage(e);
  }
}

/** Ticks every second; fetches a fresh token when the current one expires (server rotates the window). */
async function tick() {
  if (!qr.value) return;
  remaining.value = Math.max(0, Math.ceil((new Date(qr.value.expiresAt).getTime() - Date.now()) / 1000));
  if (remaining.value <= 0) await refresh();
}

onMounted(async () => {
  await refresh();
  timer = setInterval(tick, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
  text-align: center;
}
canvas {
  background: #fff;
  border-radius: 8px;
}
.error {
  color: var(--ion-color-danger);
}
</style>
