<template>
  <AppPage :title="t('doubts.ask.title')" back-href="/doubts">
    <form class="ask-form" @submit.prevent="send">
      <div v-if="aboutTitle" class="about">
        <ion-icon :icon="playCircleOutline" aria-hidden="true" />
        <div>
          <div class="muted small">{{ t('doubts.ask.about') }}</div>
          <strong>{{ aboutTitle }}</strong>
          <span v-if="position != null" class="muted"> · {{ t('doubts.ask.at', { time: clock(position) }) }}</span>
        </div>
      </div>

      <template v-else-if="options && options.batches.length">
        <ion-item v-if="options.batches.length > 1">
          <ion-select
            v-model="batchId"
            :label="t('doubts.ask.batch')"
            label-placement="stacked"
            interface="action-sheet"
          >
            <ion-select-option v-for="b in options.batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <div v-if="subjects.length" class="subjects" role="radiogroup" :aria-label="t('doubts.ask.subject')">
          <div class="muted small">{{ t('doubts.ask.subject') }}</div>
          <ion-chip
            v-for="s in subjects"
            :key="s.id"
            role="radio"
            :aria-checked="subjectId === s.id"
            :color="subjectId === s.id ? 'primary' : 'medium'"
            :outline="subjectId !== s.id"
            @click="subjectId = subjectId === s.id ? null : s.id"
            >{{ s.name }}</ion-chip
          >
        </div>
      </template>

      <ion-item>
        <ion-textarea
          v-model="question"
          :label="t('doubts.ask.question')"
          label-placement="stacked"
          :placeholder="t('doubts.ask.placeholder')"
          :auto-grow="true"
          :rows="5"
          :maxlength="DOUBT_QUESTION_MAX"
          :counter="true"
          data-testid="doubt-question"
        />
      </ion-item>

      <PhotoPicker v-model="photo" />

      <ion-button type="submit" expand="block" class="send" :disabled="sending" data-testid="send-doubt">
        <ion-icon slot="start" :icon="sendOutline" aria-hidden="true" />
        {{ t('doubts.ask.send') }}
      </ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonChip,
  IonIcon,
  IonItem,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  onIonViewWillEnter,
} from '@ionic/vue';
import { playCircleOutline, sendOutline } from 'ionicons/icons';
import { DOUBT_QUESTION_MAX, type DoubtOptionsDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { clock, doubtsApi } from './api';
import PhotoPicker from './PhotoPicker.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const num = (v: unknown) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const lectureId = computed(() => num(route.query.lectureId));
const liveClassId = computed(() => num(route.query.liveClassId));
const position = computed(() => {
  const n = Number(route.query.t);
  return lectureId.value && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
});
const aboutTitle = computed(() =>
  lectureId.value || liveClassId.value ? String(route.query.title ?? '') || ' ' : '',
);

const options = ref<DoubtOptionsDto | null>(null);
const batchId = ref<number | null>(null);
const subjectId = ref<number | null>(null);
const question = ref('');
const photo = ref<File | null>(null);
const sending = ref(false);

const subjects = computed(() => options.value?.batches.find((b) => b.id === batchId.value)?.subjects ?? []);
watch(batchId, () => (subjectId.value = null));

onIonViewWillEnter(async () => {
  if (lectureId.value || liveClassId.value) return;
  try {
    options.value = await doubtsApi.options();
    batchId.value = options.value.batches[0]?.id ?? null;
  } catch (e) {
    await toastError(e);
  }
});

async function send() {
  const text = question.value.trim();
  if (text.length < 3) {
    await toast(t('doubts.ask.tooShort'), 'warning');
    return;
  }
  sending.value = true;
  try {
    const d = await doubtsApi.ask({
      question: text,
      lectureId: lectureId.value,
      positionSeconds: position.value,
      liveClassId: liveClassId.value,
      batchId: lectureId.value || liveClassId.value ? null : batchId.value,
      subjectId: lectureId.value || liveClassId.value ? null : subjectId.value,
      photo: photo.value,
    });
    question.value = '';
    photo.value = null;
    await toast(t('doubts.ask.sent'));
    await router.replace(`/doubts/${d.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped>
.ask-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.about {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border-radius: 12px;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}
.about ion-icon {
  font-size: 28px;
  color: var(--ion-color-primary);
  flex: none;
}
.subjects {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.subjects .muted {
  width: 100%;
}
.small {
  font-size: 13px;
}
.send {
  min-height: var(--app-tap-target, 48px);
}
</style>
