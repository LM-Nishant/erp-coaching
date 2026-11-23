<template>
  <MarketShell title="Certificate" :search="false" back-href="/market">
    <div v-if="loading" class="center"><ion-spinner /></div>
    <div v-else-if="cert" class="wrap" data-testid="certificate-valid">
      <p class="valid">
        <ion-icon :icon="shieldCheckmark" color="success" /> Verified certificate of completion
      </p>
      <section class="certificate">
        <p class="eyebrow">Certificate of completion</p>
        <h1 data-testid="certificate-learner">{{ cert.learnerName }}</h1>
        <p>has successfully completed</p>
        <h2 data-testid="certificate-course">
          <router-link v-if="cert.courseSlug" :to="`/market/course/${cert.courseSlug}`">{{
            cert.courseTitle
          }}</router-link>
          <template v-else>{{ cert.courseTitle }}</template>
        </h2>
        <p class="muted">
          Offered by <strong>{{ cert.sellerName }}</strong> on the course marketplace
        </p>
        <dl>
          <div>
            <dt>Issued</dt>
            <dd>{{ issued }}</dd>
          </div>
          <div>
            <dt>Certificate ID</dt>
            <dd data-testid="certificate-code">{{ cert.code }}</dd>
          </div>
        </dl>
      </section>
      <div class="buttons">
        <ion-button data-testid="certificate-pdf" @click="openFileLink(certificatePdfUrl(cert.code))">
          <ion-icon slot="start" :icon="downloadOutline" /> Download PDF
        </ion-button>
        <ion-button fill="outline" @click="copyLink">
          <ion-icon slot="start" :icon="linkOutline" /> Copy link
        </ion-button>
      </div>
    </div>
    <div v-else class="center" data-testid="certificate-invalid">
      <ion-icon :icon="alertCircleOutline" color="danger" class="big" />
      <h2>Certificate not found</h2>
      <p class="muted">Check the certificate ID. It looks like MKT-ABCDE23456.</p>
    </div>
  </MarketShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { IonButton, IonIcon, IonSpinner } from '@ionic/vue';
import { alertCircleOutline, downloadOutline, linkOutline, shieldCheckmark } from 'ionicons/icons';
import { MKT_CERTIFICATE_CODE_PATTERN, type MktCertificateDto } from '@erp/shared';
import { openFileLink } from '@/core/downloads';
import { toast } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import { certificatePdfUrl, quizApi } from './quiz-api';

const route = useRoute();
const code = String(route.params.code ?? '').toUpperCase();
const cert = ref<MktCertificateDto | null>(null);
const loading = ref(true);

const issued = computed(() =>
  cert.value ? new Date(cert.value.issuedAt).toLocaleDateString('en-IN', { dateStyle: 'long' }) : '',
);

async function copyLink() {
  await navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
  await toast('Link copied');
}

onMounted(async () => {
  try {
    if (MKT_CERTIFICATE_CODE_PATTERN.test(code)) cert.value = (await quizApi.verify(code)).certificate;
  } catch {
    cert.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.wrap {
  max-width: 820px;
  margin: 0 auto;
}
.valid {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--ion-color-success-shade);
}
.valid ion-icon {
  font-size: 22px;
}
.certificate {
  text-align: center;
  padding: 36px 24px;
  border: 3px double var(--ion-color-primary);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(var(--ion-color-primary-rgb), 0.05), transparent 60%);
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: 13px;
  color: var(--ion-color-primary);
  margin: 0 0 18px;
}
h1 {
  font-size: clamp(24px, 5vw, 36px);
  margin: 0 0 8px;
}
h2 {
  font-size: clamp(18px, 3.5vw, 24px);
  margin: 8px 0;
}
h2 a {
  color: inherit;
}
dl {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 24px;
  margin: 24px 0 0;
}
dt {
  font-size: 12px;
  color: var(--ion-color-medium);
}
dd {
  margin: 2px 0 0;
  font-weight: 600;
}
.buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}
.muted {
  color: var(--ion-color-medium);
}
.center {
  text-align: center;
  padding: 40px 12px;
}
.big {
  font-size: 48px;
}
</style>
