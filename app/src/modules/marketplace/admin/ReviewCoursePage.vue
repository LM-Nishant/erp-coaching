<template>
  <AppPage
    :title="item?.course.title ?? 'Review course'"
    back-href="/admin/marketplace/reviews"
    :on-refresh="load"
  >
    <template v-if="item">
      <div class="head">
        <img v-if="item.course.thumbnail?.url" :src="item.course.thumbnail.url" alt="" class="thumb" />
        <div>
          <ion-badge :color="STATUS_COLORS[item.course.status]">{{
            MKT_COURSE_STATUS_LABELS[item.course.status]
          }}</ion-badge>
          <h2>{{ item.course.title }}</h2>
          <p v-if="item.course.subtitle">{{ item.course.subtitle }}</p>
          <p class="muted">
            By {{ item.seller.displayName }} ·
            {{ priceLabel({ isFree: !item.course.pricePaise, pricePaise: item.course.pricePaise }) }} ·
            {{ MKT_COURSE_LEVEL_LABELS[item.course.level] }} · {{ languageLabel(item.course.language) }} ·
            {{ item.course.lectureCount }} lectures,
            {{ durationLabel(item.course.durationSeconds) || 'no video' }}
          </p>
        </div>
      </div>

      <ion-note v-if="item.course.reviewNote" class="block">Last note: {{ item.course.reviewNote }}</ion-note>
      <ul v-if="item.issues.length" class="issues">
        <li v-for="(i, k) in item.issues" :key="k">{{ i }}</li>
      </ul>

      <div class="actions">
        <template v-if="item.course.status === 'in_review'">
          <ion-button color="success" :disabled="busy" data-testid="approve" @click="approve"
            >Approve & publish</ion-button
          >
          <ion-button color="danger" fill="outline" :disabled="busy" data-testid="reject" @click="reject"
            >Request changes</ion-button
          >
        </template>
        <ion-button
          v-if="item.course.status === 'unpublished'"
          :disabled="busy"
          @click="act(() => adminMarketApi.publish(id), 'Published')"
          >Publish again</ion-button
        >
        <ion-button
          v-if="item.course.status === 'published'"
          color="medium"
          :disabled="busy"
          @click="unpublish"
          >Unpublish</ion-button
        >
        <ion-button
          v-if="item.course.status === 'published'"
          fill="clear"
          :router-link="`/market/course/${item.course.slug}`"
          >View course page</ion-button
        >
      </div>

      <h3>Description</h3>
      <p class="prose">{{ item.course.description || '—' }}</p>
      <h3>What learners will learn</h3>
      <ul>
        <li v-for="(o, k) in item.course.outcomes" :key="k">{{ o }}</li>
      </ul>
      <template v-if="item.course.requirements.length">
        <h3>Requirements</h3>
        <ul>
          <li v-for="(o, k) in item.course.requirements" :key="k">{{ o }}</li>
        </ul>
      </template>

      <h3>Curriculum</h3>
      <ion-list v-for="s in item.course.sections" :key="s.id">
        <ion-list-header>{{ s.title }}</ion-list-header>
        <ion-item v-for="l in s.lectures" :key="l.id" button @click="open(l.id)">
          <ion-icon slot="start" :icon="lectureIcon(l.type)" />
          <ion-label>
            {{ l.title }}
            <p>
              {{ l.type }}<template v-if="l.durationSeconds"> · {{ clock(l.durationSeconds) }}</template
              ><template v-if="l.preview"> · free preview</template>
            </p>
          </ion-label>
        </ion-item>
      </ion-list>

      <h3>Seller</h3>
      <p>
        <strong>{{ item.seller.displayName }}</strong> — {{ item.seller.headline || 'no headline' }}<br />
        <span class="muted">{{ item.seller.courseCount }} courses · {{ item.seller.status }}</span>
      </p>
    </template>

    <ion-modal :is-open="!!lecture" @did-dismiss="lecture = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ lecture?.title }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="lecture = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <template v-if="lecture">
          <StreamPlayer v-if="lecture.stream" :stream="lecture.stream" />
          <QuizReview v-if="lecture.type === 'quiz'" :course-id="id" :lecture-id="lecture.id" />
          <p v-if="lecture.articleBody" class="prose">{{ lecture.articleBody }}</p>
          <ion-button v-if="lecture.download" @click="openFileLink(lecture.download.url)"
            >Download {{ lecture.download.name }}</ion-button
          >
          <p v-if="lecture.description">{{ lecture.description }}</p>
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  alertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  MKT_COURSE_LEVEL_LABELS,
  MKT_COURSE_STATUS_LABELS,
  type MktLectureContentDto,
  type MktReviewItemDto,
  type MktStudioCourseDto,
} from '@erp/shared';
import { openFileLink } from '@/core/downloads';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import StreamPlayer from '../components/StreamPlayer.vue';
import { STATUS_COLORS } from '../studio/status';
import { lectureIcon } from '../lecture-icons';
import QuizReview from '../components/QuizReview.vue';
import { adminMarketApi, clock, durationLabel, languageLabel, priceLabel } from '../api';

const route = useRoute();
const id = Number(route.params.id);
const item = ref<(MktReviewItemDto & { issues: string[] }) | null>(null);
const lecture = ref<MktLectureContentDto | null>(null);
const busy = ref(false);

async function load() {
  try {
    item.value = await adminMarketApi.course(id);
  } catch (e) {
    void toastError(e);
  }
}

async function act(fn: () => Promise<MktStudioCourseDto>, done: string) {
  busy.value = true;
  try {
    await fn();
    await load();
    await toast(done);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function prompt(header: string, required: boolean, placeholder: string) {
  const alert = await alertController.create({
    header,
    inputs: [{ name: 'text', type: 'textarea', placeholder }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Confirm', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { text: string } }>();
  if (role !== 'confirm') return null;
  const text = data?.values.text?.trim() ?? '';
  if (required && !text) {
    await toast('Please give a reason so the seller knows what to fix.');
    return null;
  }
  return text;
}

async function approve() {
  const note = await prompt('Approve course', false, 'Optional note to the seller');
  if (note !== null) await act(() => adminMarketApi.approve(id, note), 'Approved and published');
}
async function reject() {
  const reason = await prompt('Request changes', true, 'What should the seller change?');
  if (reason) await act(() => adminMarketApi.reject(id, reason), 'Sent back to the seller');
}
async function unpublish() {
  const reason = await prompt('Unpublish course', false, 'Optional reason');
  if (reason !== null) await act(() => adminMarketApi.unpublish(id, reason), 'Unpublished');
}

async function open(lectureId: number) {
  try {
    lecture.value = await adminMarketApi.lecture(id, lectureId);
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.head {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.thumb {
  width: 240px;
  max-width: 100%;
  border-radius: 8px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}
.muted {
  color: var(--ion-color-medium);
}
.block {
  display: block;
  margin: 8px 0;
}
.issues {
  color: var(--ion-color-danger);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.prose {
  white-space: pre-wrap;
}
</style>
