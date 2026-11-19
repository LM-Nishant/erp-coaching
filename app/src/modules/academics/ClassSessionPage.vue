<template>
  <AppPage
    :title="cls ? `${cls.batch?.name ?? 'Class'} · ${cls.date}` : 'Class'"
    back-href="/my-timetable"
    :on-refresh="load"
  >
    <template v-if="cls">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>
            {{ weekdayOf(cls.date) }} {{ cls.date }} · {{ cls.startTime }}–{{ cls.endTime }}
            <ion-badge :color="statusColor(cls.status)">{{ cls.status }}</ion-badge>
          </ion-card-subtitle>
          <ion-card-title>{{ cls.subject?.name ?? cls.batch?.name }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p>Teacher: {{ cls.teacher?.name }}<span v-if="cls.originalTeacherUserId"> (substitute)</span></p>
          <p>Room: {{ cls.classroom?.name ?? '—' }}</p>
          <p v-if="cls.rescheduledFrom">Originally {{ cls.rescheduledFrom }}</p>
          <p v-if="cls.cancelReason">Note: {{ cls.cancelReason }}</p>
          <p v-if="cls.status === 'completed'">
            Held for {{ cls.actualDurationMinutes }} min<span v-if="cls.completionNotes">
              · {{ cls.completionNotes }}</span
            >
          </p>
          <ion-button
            v-if="canTeach && cls.status === 'scheduled' && cls.date <= isoToday()"
            size="small"
            @click="complete"
            >Mark completed</ion-button
          >
        </ion-card-content>
      </ion-card>

      <ion-list-header>
        <ion-label>Notes &amp; homework</ion-label>
        <ion-button v-if="canTeach && auth.can('class-notes.create')" @click="openNote">Add</ion-button>
      </ion-list-header>

      <ion-card v-for="n in notes" :key="n.id">
        <ion-card-header>
          <ion-card-subtitle>
            <ion-badge :color="n.kind === 'homework' ? 'warning' : 'medium'">{{ n.kind }}</ion-badge>
            <span v-if="n.dueDate"> due {{ n.dueDate }}</span>
          </ion-card-subtitle>
          <ion-card-title>{{ n.title }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p class="pre">{{ n.body }}</p>
          <p v-for="a in n.attachments" :key="a.fileId">
            <a :href="a.url" target="_blank" rel="noopener"
              ><ion-icon :icon="attachOutline" /> {{ a.name }}</a
            >
          </p>
          <ion-button
            v-if="n.authorUserId === auth.me?.user.id || auth.can('academics.edit')"
            fill="clear"
            size="small"
            color="danger"
            @click="removeNote(n.id)"
            >Delete</ion-button
          >
          <ion-list lines="none">
            <ion-item v-for="c in n.comments" :key="c.id">
              <ion-label class="ion-text-wrap">
                <strong>{{ c.user?.name }}</strong> {{ c.body }}
              </ion-label>
              <ion-button
                v-if="c.userId === auth.me?.user.id || auth.can('class-notes.delete')"
                slot="end"
                fill="clear"
                size="small"
                aria-label="Delete comment"
                @click="removeComment(c.id)"
                ><ion-icon slot="icon-only" :icon="closeOutline"
              /></ion-button>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="drafts[n.id]"
                placeholder="Write a comment…"
                aria-label="Comment"
                @keyup.enter="comment(n.id)"
              />
              <ion-button
                slot="end"
                fill="clear"
                :disabled="!drafts[n.id]?.trim()"
                aria-label="Post comment"
                @click="comment(n.id)"
                ><ion-icon slot="icon-only" :icon="sendOutline"
              /></ion-button>
            </ion-item>
          </ion-list>
        </ion-card-content>
      </ion-card>
      <p v-if="!notes.length" class="muted ion-padding">No notes yet.</p>
    </template>

    <ion-modal :is-open="!!noteForm" @did-dismiss="noteForm = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>New note</ion-title>
          <ion-buttons slot="end"><ion-button @click="noteForm = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="noteForm" @submit.prevent="saveNote">
          <ion-segment v-model="noteForm.kind">
            <ion-segment-button value="note"><ion-label>Class note</ion-label></ion-segment-button>
            <ion-segment-button value="homework"><ion-label>Homework</ion-label></ion-segment-button>
          </ion-segment>
          <ion-list>
            <ion-item
              ><ion-input v-model="noteForm.title" label="Title" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-textarea v-model="noteForm.body" label="Details" label-placement="stacked" auto-grow
            /></ion-item>
            <ion-item v-if="noteForm.kind === 'homework'"
              ><ion-input v-model="noteForm.dueDate" type="date" label="Due" label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-label>Attachments</ion-label>
              <input type="file" multiple @change="onFiles" />
            </ion-item>
            <ion-item v-for="f in noteForm.files" :key="f.id"
              ><ion-label>{{ f.originalName }}</ion-label></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Post</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { attachOutline, closeOutline, sendOutline } from 'ionicons/icons';
import type { ClassNoteDto, ClassNoteKind, ClassSessionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api, type UploadedFile } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi, isoToday, statusColor, weekdayOf } from './api';

const route = useRoute();
const auth = useAuthStore();
const id = Number(route.params.id);
const cls = ref<ClassSessionDto | null>(null);
const notes = ref<ClassNoteDto[]>([]);
const drafts = reactive<Record<number, string>>({});
const saving = ref(false);
const noteForm = ref<{
  kind: ClassNoteKind;
  title: string;
  body: string;
  dueDate: string;
  files: UploadedFile[];
} | null>(null);

const canTeach = computed(
  () => !!cls.value && (auth.can('academics.edit') || cls.value.teacherUserId === auth.me?.user.id),
);

async function load() {
  try {
    cls.value = await academicsApi.classSession(id);
    notes.value = auth.can('class-notes.view') ? await academicsApi.notes(id) : [];
  } catch (e) {
    await toastError(e);
  }
}

async function complete() {
  if (!cls.value) return;
  const [sh, sm] = cls.value.startTime.split(':').map(Number);
  const [eh, em] = cls.value.endTime.split(':').map(Number);
  const alert = await alertController.create({
    header: 'Mark class completed',
    inputs: [
      {
        name: 'minutes',
        type: 'number',
        placeholder: 'Actual minutes',
        value: String(eh * 60 + em - (sh * 60 + sm)),
      },
      { name: 'notes', type: 'textarea', placeholder: 'What was covered (optional)' },
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { minutes: string; notes: string } }>();
  if (role !== 'confirm' || !data) return;
  try {
    cls.value = {
      ...cls.value,
      ...(await academicsApi.complete(id, {
        actualDurationMinutes: Number(data.values.minutes),
        completionNotes: data.values.notes || null,
      })),
    };
    await toast('Class marked completed');
  } catch (e) {
    await toastError(e);
  }
}

function openNote() {
  noteForm.value = { kind: 'note', title: '', body: '', dueDate: '', files: [] };
}

async function onFiles(ev: Event) {
  const input = ev.target as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) {
    try {
      noteForm.value?.files.push(await api.upload(file, { module: 'academics' }));
    } catch (e) {
      await toastError(e);
    }
  }
  input.value = '';
}

async function saveNote() {
  if (!noteForm.value) return;
  saving.value = true;
  const f = noteForm.value;
  try {
    await academicsApi.addNote(id, {
      kind: f.kind,
      title: f.title,
      body: f.body || null,
      dueDate: f.kind === 'homework' && f.dueDate ? f.dueDate : null,
      fileIds: f.files.map((x) => x.id),
    });
    noteForm.value = null;
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function removeNote(noteId: number) {
  try {
    await academicsApi.removeNote(noteId);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function comment(noteId: number) {
  const body = drafts[noteId]?.trim();
  if (!body) return;
  try {
    await academicsApi.comment(noteId, body);
    drafts[noteId] = '';
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function removeComment(commentId: number) {
  try {
    await academicsApi.removeComment(commentId);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.pre {
  white-space: pre-wrap;
}
</style>
