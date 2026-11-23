<template>
  <AppPage :title="a?.title ?? 'Homework'" back-href="/lms/homework" :on-refresh="load">
    <template v-if="a">
      <p class="muted">
        {{ a.batchName }}<span v-if="a.subjectName"> · {{ a.subjectName }}</span> · due
        {{ formatDateTime(a.dueAt) }}
        <span v-if="a.maxMarks"> · {{ a.maxMarks }} marks</span>
        <span v-if="a.allowLate"> · late submissions accepted</span>
      </p>
      <div v-if="!isStaff" class="due-row">
        <StatusChip
          :label="t(`lms.homework.state.${homeworkState(a)}`)"
          :tone="HOMEWORK_TONE[homeworkState(a)]"
        />
        <span v-if="!a.mySubmission && a.status !== 'closed'" class="muted">{{
          t('lms.homework.dueRelative', { when: formatRelative(a.dueAt) })
        }}</span>
      </div>
      <p v-if="a.instructions" class="pre">{{ a.instructions }}</p>
      <FileLinks :files="a.files" />

      <!-- staff -->
      <template v-if="isStaff">
        <div class="actions">
          <ion-badge :color="a.status === 'published' ? 'primary' : 'medium'">{{ a.status }}</ion-badge>
          <ion-button v-if="a.status === 'draft'" @click="act(() => lmsApi.publishAssignment(a!.id))"
            >Publish & notify</ion-button
          >
          <ion-button
            v-if="a.status === 'published'"
            fill="outline"
            @click="act(() => lmsApi.closeAssignment(a!.id))"
            >Close</ion-button
          >
          <ion-button v-if="a.status !== 'closed'" fill="outline" :router-link="`/lms/homework/${a.id}/edit`"
            >Edit</ion-button
          >
          <ion-button v-can="'lms-assignments.delete'" fill="clear" color="danger" @click="remove"
            >Delete</ion-button
          >
        </div>
        <ion-list>
          <ion-list-header>
            <ion-label
              >Submissions
              <span v-if="a.counts">({{ a.counts.submitted }}/{{ a.counts.students }})</span></ion-label
            >
          </ion-list-header>
          <ion-card v-for="s in submissions" :key="s.id">
            <ion-card-header>
              <ion-card-title>{{ s.student.name }}</ion-card-title>
              <ion-card-subtitle>
                {{ formatDateTime(s.submittedAt) }} <span v-if="s.isLate">· late</span> · {{ s.status }}
              </ion-card-subtitle>
            </ion-card-header>
            <ion-card-content>
              <p v-if="s.text" class="pre">{{ s.text }}</p>
              <FileLinks :files="s.files" />
              <ion-item>
                <ion-input
                  v-model.number="grading[s.id].marks"
                  type="number"
                  :label="a.maxMarks ? `Marks / ${a.maxMarks}` : 'Marks'"
                  label-placement="stacked"
                  :min="0"
                  :max="a.maxMarks ?? undefined"
                />
              </ion-item>
              <ion-item>
                <ion-textarea
                  v-model="grading[s.id].feedback"
                  label="Feedback"
                  label-placement="stacked"
                  :auto-grow="true"
                />
              </ion-item>
              <ion-button size="small" @click="grade(s.id, 'graded')">Save grade</ion-button>
              <ion-button size="small" fill="outline" color="warning" @click="grade(s.id, 'returned')"
                >Return for redo</ion-button
              >
            </ion-card-content>
          </ion-card>
          <ion-item v-if="!submissions.length"
            ><ion-label class="muted">No submissions yet.</ion-label></ion-item
          >
        </ion-list>
      </template>

      <!-- learner / parent -->
      <template v-else>
        <ion-card v-if="mine">
          <ion-card-header>
            <ion-card-subtitle>
              {{ a.student ? `${a.student.name}'s submission` : 'Your submission' }} ·
              {{ formatDateTime(mine.submittedAt) }} <span v-if="mine.isLate">· late</span> ·
              {{ mine.status }}
            </ion-card-subtitle>
          </ion-card-header>
          <ion-card-content>
            <p v-if="mine.text" class="pre">{{ mine.text }}</p>
            <FileLinks :files="mine.files" />
            <template v-if="mine.status !== 'submitted'">
              <h3 v-if="mine.marks !== null">
                Marks: {{ mine.marks }}<span v-if="a.maxMarks"> / {{ a.maxMarks }}</span>
              </h3>
              <p v-if="mine.feedback" class="pre"><strong>Feedback:</strong> {{ mine.feedback }}</p>
            </template>
          </ion-card-content>
        </ion-card>
        <p v-else-if="isParent" class="muted">{{ t('lms.homework.notSubmitted') }}</p>

        <form v-if="canSubmit" @submit.prevent="submit">
          <ion-list>
            <ion-list-header
              ><ion-label>{{
                mine ? t('lms.homework.update') : t('lms.homework.submitWork')
              }}</ion-label></ion-list-header
            >
            <ion-item>
              <ion-textarea
                v-model="answer.text"
                label="Answer"
                label-placement="stacked"
                :auto-grow="true"
                :rows="4"
              />
            </ion-item>
            <ion-item>
              <ion-label>
                <p>{{ t('lms.homework.filesHint') }}</p>
                <p v-for="f in answer.files" :key="f.id">{{ f.originalName }}</p>
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,.doc,.docx"
                  :disabled="uploading"
                  @change="pick"
                />
                <label class="camera">
                  <ion-icon :icon="cameraOutline" aria-hidden="true" />{{ t('lms.homework.takePhoto') }}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    :disabled="uploading"
                    @change="pick"
                  />
                </label>
              </ion-label>
            </ion-item>
          </ion-list>
          <ion-button
            expand="block"
            type="submit"
            :disabled="uploading || (!answer.text && !answer.files.length)"
            >{{ t('lms.homework.submit') }}</ion-button
          >
        </form>
        <p v-else-if="isLearner && !mine && past" class="muted">{{ t('lms.homework.pastDue') }}</p>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonTextarea,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import { cameraOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { LmsAssignmentDto, LmsFileRef, LmsSubmissionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime, formatRelative } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { lmsApi } from './api';
import { HOMEWORK_TONE, homeworkState } from './homework';
import FileLinks from './FileLinks.vue';
import { useLmsRole } from './roles';

const route = useRoute();
const router = useRouter();
const { isStaff, isLearner, isParent } = useLmsRole();
const { t } = useI18n();
const id = computed(() => Number(route.params.id));

const a = ref<LmsAssignmentDto | null>(null);
const submissions = ref<LmsSubmissionDto[]>([]);
const grading = reactive<Record<number, { marks: number | null; feedback: string }>>({});
const answer = reactive({ text: '', files: [] as LmsFileRef[] });
const uploading = ref(false);

const mine = computed(() => a.value?.mySubmission ?? null);
const past = computed(() => !!a.value && new Date(a.value.dueAt) < new Date());
const canSubmit = computed(
  () =>
    isLearner.value &&
    a.value?.status === 'published' &&
    mine.value?.status !== 'graded' &&
    (!past.value || a.value.allowLate),
);

async function load() {
  try {
    if (isParent.value) {
      const student = Number(route.query.student) || undefined;
      const list = await lmsApi.childrenAssignments({ studentUserId: student });
      a.value = list.find((x) => x.id === id.value) ?? (await lmsApi.assignment(id.value));
    } else a.value = await lmsApi.assignment(id.value);
    if (isStaff.value) {
      submissions.value = await lmsApi.submissions(id.value);
      for (const s of submissions.value) grading[s.id] = { marks: s.marks, feedback: s.feedback ?? '' };
    } else if (mine.value) {
      answer.text = mine.value.text ?? '';
      answer.files = [...mine.value.files];
    }
  } catch (e) {
    await toastError(e);
  }
}

async function act(fn: () => Promise<LmsAssignmentDto>) {
  try {
    await fn();
    await toast('Updated');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function grade(submissionId: number, status: 'graded' | 'returned') {
  const g = grading[submissionId];
  try {
    await lmsApi.grade(submissionId, {
      marks: g.marks === null || (g.marks as unknown) === '' ? null : Number(g.marks),
      feedback: g.feedback || null,
      status,
    });
    await toast(status === 'graded' ? 'Graded — student notified' : 'Returned to student');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function pick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  uploading.value = true;
  try {
    for (const f of Array.from(input.files ?? [])) answer.files.push(await lmsApi.uploadFile(f));
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function submit() {
  try {
    await lmsApi.submit(id.value, { text: answer.text || null, fileIds: answer.files.map((f) => f.id) });
    await toast('Submitted');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function remove() {
  const al = await alertController.create({
    header: 'Delete homework?',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await al.present();
  if ((await al.onDidDismiss()).role !== 'destructive') return;
  try {
    await lmsApi.removeAssignment(id.value);
    await router.replace('/lms/homework');
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.pre {
  white-space: pre-wrap;
}
.due-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.camera {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: var(--app-tap-target, 48px);
  margin-top: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-weight: 600;
  color: var(--ion-color-primary-contrast);
  background: var(--ion-color-primary);
  cursor: pointer;
}
.camera input {
  display: none;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
