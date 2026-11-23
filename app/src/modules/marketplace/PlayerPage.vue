<template>
  <MarketShell
    :title="player?.course.title ?? 'Course'"
    back-href="/market/learning"
    :search="false"
    :padded="false"
    wide
  >
    <template #toolbar>
      <ion-progress-bar v-if="player" :value="player.progressPercent / 100" />
    </template>
    <div v-if="player" class="player">
      <main class="stage">
        <CertificateBanner v-if="player.certificateCode" :code="player.certificateCode" />
        <template v-if="lecture">
          <StreamPlayer
            v-if="lecture.type === 'video'"
            :key="lecture.id"
            :stream="lecture.stream"
            :start-at="lecture.positionSeconds"
            :poster="player.course.thumbnailUrl"
            data-testid="lecture-video"
            @time="onTime"
            @pause="(t) => save({ positionSeconds: t })"
            @ended="save({ completed: true })"
            @expired="reloadLecture"
          />
          <article v-else-if="lecture.type === 'article'" class="article" data-testid="lecture-article">
            {{ lecture.articleBody }}
          </article>
          <QuizPlayer
            v-else-if="lecture.type === 'quiz'"
            :key="`quiz-${lecture.id}`"
            :course-id="courseId"
            :lecture-id="lecture.id"
            @result="onQuizResult"
          />
          <div v-else-if="lecture.download" class="resource">
            <ion-icon :icon="documentAttachOutline" />
            <p>
              {{ lecture.download.name }} · {{ (lecture.download.sizeBytes / 1024 / 1024).toFixed(1) }} MB
            </p>
            <ion-button data-testid="lecture-download" @click="download(lecture.download.url)"
              >Download</ion-button
            >
          </div>
          <div class="lecture-bar">
            <div>
              <h2 data-testid="lecture-title">{{ lecture.title }}</h2>
              <p v-if="lecture.description" class="muted">{{ lecture.description }}</p>
            </div>
            <div class="actions">
              <ion-button fill="outline" size="small" :disabled="!prev" @click="prev && open(prev.id)"
                >Previous</ion-button
              >
              <ion-button
                v-if="lecture.type !== 'quiz'"
                size="small"
                :color="lecture.completed ? 'success' : 'primary'"
                data-testid="mark-complete"
                @click="toggleComplete"
                >{{ lecture.completed ? 'Completed ✓' : 'Mark complete' }}</ion-button
              >
              <ion-button fill="outline" size="small" :disabled="!next" @click="next && open(next.id)"
                >Next</ion-button
              >
            </div>
          </div>
        </template>
        <div v-else class="center"><ion-spinner /></div>
        <section id="qa" class="engage">
          <h2>Questions &amp; answers</h2>
          <QaPanel
            :course-id="courseId"
            :lecture-id="lecture?.id ?? null"
            :lecture-title="lecture?.title"
            :question-id="questionId"
          />
        </section>
      </main>

      <aside class="curriculum">
        <div class="progress" data-testid="course-progress">
          <strong>{{ player.progressPercent }}%</strong> complete
          <router-link
            :to="`/market/course/${player.course.slug}#reviews`"
            class="rate"
            data-testid="rate-course"
            >Rate this course</router-link
          >
        </div>
        <ion-list v-for="s in player.sections" :key="s.id" lines="none">
          <ion-list-header>{{ s.title }}</ion-list-header>
          <ion-item
            v-for="l in s.lectures"
            :key="l.id"
            button
            :detail="false"
            :class="{ current: l.id === lecture?.id }"
            :data-testid="`lecture-${l.id}`"
            @click="open(l.id)"
          >
            <ion-icon
              slot="start"
              :icon="l.completed ? checkmarkCircle : lectureIcon(l.type)"
              :color="l.completed ? 'success' : 'medium'"
            />
            <ion-label class="ion-text-wrap">{{ l.title }}</ion-label>
            <ion-note slot="end">{{ l.durationSeconds ? clock(l.durationSeconds) : '' }}</ion-note>
          </ion-item>
        </ion-list>
      </aside>
    </div>
    <div v-else class="center"><ion-spinner /></div>
  </MarketShell>
</template>

<script setup lang="ts">
import { openFileLink } from '@/core/downloads';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonProgressBar,
  IonSpinner,
} from '@ionic/vue';
import { checkmarkCircle, documentAttachOutline } from 'ionicons/icons';
import type { MktLectureContentDto, MktPlayerDto, MktProgressInput, MktQuizResultDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import StreamPlayer from './components/StreamPlayer.vue';
import QuizPlayer from './components/QuizPlayer.vue';
import CertificateBanner from './components/CertificateBanner.vue';
import QaPanel from './components/QaPanel.vue';
import { clock, marketApi } from './api';
import { lectureIcon } from './lecture-icons';

/** The video position is saved this often while it plays. */
const SAVE_EVERY_SECONDS = 15;

const route = useRoute();
const router = useRouter();
const courseId = Number(route.params.id);
/** A notification link opens one question in the Q&A. */
const questionId = Number(route.query.questionId) || null;
const openQa = route.query.tab === 'qa' || !!questionId;
const player = ref<MktPlayerDto | null>(null);
const lecture = ref<MktLectureContentDto | null>(null);
let lastSaved = 0;
let position = 0;

const flat = computed(() => player.value?.sections.flatMap((s) => s.lectures) ?? []);
const index = computed(() => flat.value.findIndex((l) => l.id === lecture.value?.id));
const prev = computed(() => (index.value > 0 ? flat.value[index.value - 1] : null));
const next = computed(() => (index.value >= 0 ? (flat.value[index.value + 1] ?? null) : null));

async function open(lectureId: number) {
  if (lecture.value?.type === 'video' && position) void save({ positionSeconds: position }, true);
  lecture.value = null;
  position = 0;
  lastSaved = 0;
  void router.replace({ query: { lecture: String(lectureId) } });
  try {
    lecture.value = await marketApi.lecture(courseId, lectureId);
    if (lecture.value.type === 'article' && !lecture.value.completed) void save({ positionSeconds: 0 }, true);
  } catch (e) {
    void toastError(e);
  }
}

async function reloadLecture() {
  if (!lecture.value) return;
  const at = position;
  lecture.value = { ...(await marketApi.lecture(courseId, lecture.value.id)), positionSeconds: at };
}

function onTime(t: number) {
  position = t;
  if (Math.abs(t - lastSaved) >= SAVE_EVERY_SECONDS) void save({ positionSeconds: t }, true);
}

async function save(body: MktProgressInput, background = false) {
  const current = lecture.value;
  const p = player.value;
  if (!current || !p) return;
  if (body.positionSeconds !== undefined) lastSaved = body.positionSeconds;
  try {
    const res = await marketApi.progress(courseId, current.id, body, background);
    p.progressPercent = res.progressPercent;
    if (res.certificateCode) p.certificateCode = res.certificateCode;
    const item = flat.value.find((l) => l.id === res.lectureId);
    if (item) {
      item.completed = res.completed;
      item.positionSeconds = res.positionSeconds;
    }
    if (lecture.value?.id === res.lectureId) lecture.value.completed = res.completed;
  } catch (e) {
    if (!background) void toastError(e);
  }
}

function onQuizResult(res: MktQuizResultDto) {
  const p = player.value;
  if (!p) return;
  p.progressPercent = res.progressPercent;
  if (res.certificateCode) p.certificateCode = res.certificateCode;
  const item = flat.value.find((l) => l.id === lecture.value?.id);
  if (item && res.passed) item.completed = true;
  if (lecture.value && res.passed) lecture.value.completed = true;
}

const toggleComplete = () => save({ completed: !lecture.value?.completed });

onMounted(async () => {
  try {
    player.value = await marketApi.player(courseId);
  } catch (e) {
    void toastError(e);
    return;
  }
  const asked = Number(route.query.lecture);
  const first = flat.value.find((l) => !l.completed) ?? flat.value[0];
  const start = flat.value.some((l) => l.id === asked) ? asked : (player.value.lastLectureId ?? first?.id);
  if (start) await open(start);
  if (openQa) document.getElementById('qa')?.scrollIntoView();
});

onBeforeUnmount(() => {
  if (lecture.value?.type === 'video' && position) void save({ positionSeconds: position }, true);
});

function download(url: string) {
  openFileLink(url);
  void save({ completed: true });
}
</script>

<style scoped>
.player {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  min-height: 100%;
}
@media (max-width: 900px) {
  .player {
    grid-template-columns: 1fr;
  }
}
.stage {
  padding: 12px;
}
.stage :deep(.stream-player) {
  border-radius: 0;
}
.article {
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 16px;
  padding: 8px 4px 24px;
  max-width: 760px;
}
.resource {
  text-align: center;
  padding: 40px 12px;
  background: var(--ion-color-light);
  border-radius: 8px;
}
.resource ion-icon {
  font-size: 48px;
}
.lecture-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}
.lecture-bar h2 {
  margin: 0;
  font-size: 18px;
}
.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.curriculum {
  border-left: 1px solid var(--ion-color-light-shade);
}
.progress {
  padding: 12px 16px 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.rate {
  font-size: 13px;
}
.engage {
  margin-top: 24px;
  border-top: 1px solid var(--ion-color-light-shade);
}
.engage h2 {
  font-size: 18px;
}
ion-item.current {
  --background: rgba(var(--ion-color-primary-rgb), 0.12);
}
.muted {
  color: var(--ion-color-medium);
}
.center {
  text-align: center;
  padding: 40px;
}
</style>
