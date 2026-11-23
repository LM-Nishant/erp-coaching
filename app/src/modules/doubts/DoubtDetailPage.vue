<template>
  <AppPage :title="t('doubts.detail.title')" :back-href="backHref" :on-refresh="load">
    <template v-if="doubt">
      <div class="head">
        <div class="context">
          <span>{{ contextLine }}</span>
          <StatusChip :label="t(`doubts.status.${doubt.status}`)" :tone="STATUS_TONE[doubt.status]" />
        </div>
        <ion-button
          v-if="doubt.lecture"
          size="small"
          fill="outline"
          :router-link="lectureLink"
          data-testid="open-lecture"
        >
          <ion-icon slot="start" :icon="playCircleOutline" aria-hidden="true" />
          {{ t('doubts.detail.openLecture') }}
          <template v-if="doubt.lecture.positionSeconds != null">
            · {{ clock(doubt.lecture.positionSeconds) }}</template
          >
        </ion-button>
      </div>

      <div class="thread" aria-live="polite">
        <div class="bubble mine-side" :class="{ right: doubt.isMine }">
          <div class="who">
            {{ doubt.isMine ? t('doubts.detail.you') : doubt.student?.name }} · {{ formatDateTime(doubt.createdAt) }}
          </div>
          <p class="text">{{ doubt.question }}</p>
          <a v-if="doubt.photoUrl" :href="doubt.photoUrl" target="_blank" rel="noopener">
            <img :src="doubt.photoUrl" :alt="t('doubts.detail.photo')" />
          </a>
        </div>
        <div
          v-for="r in doubt.replies"
          :key="r.id"
          class="bubble"
          :class="{ teacher: r.fromTeacher, right: r.author?.id === auth.me?.user.id }"
        >
          <div class="who">
            {{ r.author?.id === auth.me?.user.id ? t('doubts.detail.you') : r.author?.name }}
            <span v-if="r.fromTeacher" class="tag">{{ t('doubts.detail.teacherLabel') }}</span>
            · {{ formatDateTime(r.createdAt) }}
          </div>
          <p v-if="r.body" class="text">{{ r.body }}</p>
          <a v-if="r.photoUrl" :href="r.photoUrl" target="_blank" rel="noopener">
            <img :src="r.photoUrl" :alt="t('doubts.detail.photo')" />
          </a>
        </div>
      </div>

      <p class="muted assigned">
        {{
          doubt.teacher ? t('doubts.detail.teacher', { name: doubt.teacher.name }) : t('doubts.detail.noTeacher')
        }}
      </p>

      <p v-if="doubt.status === 'resolved'" class="solved-note">
        <ion-icon :icon="checkmarkCircle" color="success" aria-hidden="true" />
        {{ t('doubts.detail.solvedNote') }}
      </p>
      <template v-else-if="doubt.isMine || doubt.canAnswer">
        <form class="composer" @submit.prevent="send">
          <ion-textarea
            v-model="body"
            :placeholder="doubt.canAnswer ? t('doubts.detail.replyPlaceholder') : t('doubts.detail.followUpPlaceholder')"
            :auto-grow="true"
            :rows="2"
            :maxlength="DOUBT_QUESTION_MAX"
            fill="outline"
            data-testid="doubt-reply"
          />
          <div class="composer-actions">
            <PhotoPicker ref="picker" v-model="photo" compact />
            <ion-button type="submit" :disabled="sending || (!body.trim() && !photo)" data-testid="send-reply">
              <ion-icon slot="start" :icon="sendOutline" aria-hidden="true" />
              {{ t('doubts.detail.send') }}
            </ion-button>
          </div>
        </form>
        <ion-button
          v-if="doubt.isMine || doubt.status === 'answered'"
          expand="block"
          fill="outline"
          color="success"
          class="solve"
          :disabled="sending"
          data-testid="mark-solved"
          @click="resolve"
        >
          <ion-icon slot="start" :icon="checkmarkCircleOutline" aria-hidden="true" />
          {{ t('doubts.detail.markSolved') }}
        </ion-button>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { IonButton, IonIcon, IonTextarea, onIonViewWillEnter } from '@ionic/vue';
import {
  checkmarkCircle,
  checkmarkCircleOutline,
  playCircleOutline,
  sendOutline,
} from 'ionicons/icons';
import { DOUBT_QUESTION_MAX, type DoubtDetailDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { STATUS_TONE, clock, doubtsApi } from './api';
import PhotoPicker from './PhotoPicker.vue';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const doubt = ref<DoubtDetailDto | null>(null);
const body = ref('');
const photo = ref<File | null>(null);
const sending = ref(false);
const picker = ref<InstanceType<typeof PhotoPicker>>();

const backHref = computed(() => (doubt.value && !doubt.value.isMine ? '/doubts/inbox' : '/doubts'));
const contextLine = computed(() => {
  const d = doubt.value;
  if (!d) return '';
  return [d.subject?.name, d.lecture?.title ?? d.liveClass?.title, d.batch?.name].filter(Boolean).join(' · ');
});
const lectureLink = computed(() => {
  const l = doubt.value?.lecture;
  if (!l) return '';
  return l.positionSeconds != null ? `/lms/resources/${l.id}?t=${l.positionSeconds}` : `/lms/resources/${l.id}`;
});

async function load() {
  try {
    doubt.value = await doubtsApi.get(id.value);
  } catch (e) {
    await toastError(e);
  }
}

async function send() {
  sending.value = true;
  try {
    doubt.value = await doubtsApi.reply(id.value, body.value.trim(), photo.value);
    body.value = '';
    picker.value?.clear();
  } catch (e) {
    await toastError(e);
  } finally {
    sending.value = false;
  }
}

async function resolve() {
  sending.value = true;
  try {
    doubt.value = await doubtsApi.resolve(id.value);
  } catch (e) {
    await toastError(e);
  } finally {
    sending.value = false;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.context {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--ion-color-medium-shade);
}
.thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bubble {
  max-width: 88%;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--ion-color-light);
  align-self: flex-start;
}
.bubble.right {
  align-self: flex-end;
  background: rgba(var(--ion-color-primary-rgb), 0.1);
}
.bubble.teacher:not(.right) {
  background: rgba(var(--ion-color-success-rgb), 0.12);
}
.who {
  font-size: 12px;
  color: var(--ion-color-medium-shade);
}
.tag {
  font-weight: 600;
  color: var(--ion-color-success-shade);
}
.text {
  margin: 4px 0 0;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.45;
}
.bubble img {
  margin-top: 6px;
  max-width: 100%;
  max-height: 260px;
  border-radius: 10px;
}
.assigned {
  font-size: 13px;
  margin: 12px 0;
}
.solved-note {
  display: flex;
  gap: 8px;
  align-items: center;
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.composer-actions ion-button[type='submit'],
.solve {
  min-height: var(--app-tap-target, 48px);
}
</style>
