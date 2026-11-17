<template>
  <AppPage title="AI grading prompts" back-href="/exams" :on-refresh="load">
    <ion-card>
      <ion-card-header>
        <ion-card-subtitle>
          <ion-badge :color="active ? 'medium' : 'success'">{{ active ? 'inactive' : 'active' }}</ion-badge>
          Built-in default
        </ion-card-subtitle>
      </ion-card-header>
      <ion-card-content>
        <pre>{{ data?.defaultPrompt }}</pre>
        <ion-button v-if="active" size="small" fill="outline" @click="activate(null)">Use default</ion-button>
      </ion-card-content>
    </ion-card>

    <ion-card v-for="v in data?.versions ?? []" :key="v.id">
      <ion-card-header>
        <ion-card-subtitle>
          <ion-badge :color="v.isActive ? 'success' : 'medium'">{{
            v.isActive ? 'active' : `v${v.version}`
          }}</ion-badge>
          {{ formatDate(v.createdAt) }}
        </ion-card-subtitle>
        <ion-card-title>{{ v.name }}</ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <p v-if="v.notes" class="muted">{{ v.notes }}</p>
        <details>
          <summary>System prompt</summary>
          <pre>{{ v.systemPrompt }}</pre>
        </details>
        <div class="row">
          <ion-button v-if="!v.isActive" size="small" @click="activate(v.id)">Activate</ion-button>
          <ion-button size="small" fill="clear" @click="startFrom(v.systemPrompt, v.name)"
            >Copy as new version</ion-button
          >
        </div>
      </ion-card-content>
    </ion-card>

    <ion-card>
      <ion-card-header><ion-card-title>New version</ion-card-title></ion-card-header>
      <ion-card-content>
        <ion-item>
          <ion-input v-model="form.name" label="Name" label-placement="stacked" :maxlength="120" />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.systemPrompt"
            label="System prompt"
            label-placement="stacked"
            :rows="10"
            auto-grow
          />
        </ion-item>
        <ion-item>
          <ion-input v-model="form.notes" label="Notes" label-placement="stacked" />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.activate">Activate immediately</ion-toggle>
        </ion-item>
        <p class="muted">
          The model must return JSON <code>{"marks": number, "feedback": string, "confidence": 0..1}</code>;
          the question, rubric, model answer and the student's answer are appended automatically. Each AI
          result records the prompt version used.
        </p>
        <div class="row">
          <ion-button :disabled="!form.name.trim() || !form.systemPrompt.trim()" @click="create"
            >Save version</ion-button
          >
          <ion-button fill="clear" @click="startFrom(data?.defaultPrompt ?? '', 'Default')"
            >Start from default</ion-button
          >
        </div>
      </ion-card-content>
    </ion-card>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonInput,
  IonItem,
  IonTextarea,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { examsApi, formatDate, type PromptVersionList } from './api';

const data = ref<PromptVersionList | null>(null);
const active = computed(() => data.value?.versions.some((v) => v.isActive) ?? false);
const form = reactive({ name: '', systemPrompt: '', notes: '', activate: true });

async function load() {
  try {
    data.value = await examsApi.promptVersions();
  } catch (e) {
    await toastError(e);
  }
}
onIonViewWillEnter(load);

function startFrom(prompt: string, name: string) {
  form.systemPrompt = prompt;
  form.name = `${name} (copy)`;
}

async function activate(versionId: number | null) {
  try {
    data.value = await examsApi.activatePromptVersion(versionId);
    await toast(versionId ? 'Prompt version activated' : 'Using the built-in default prompt');
  } catch (e) {
    await toastError(e);
  }
}

async function create() {
  try {
    await examsApi.createPromptVersion({
      name: form.name.trim(),
      systemPrompt: form.systemPrompt.trim(),
      notes: form.notes.trim() || null,
      activate: form.activate,
    });
    Object.assign(form, { name: '', systemPrompt: '', notes: '', activate: true });
    await toast('Prompt version saved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
pre {
  white-space: pre-wrap;
  font-size: 0.8rem;
  background: var(--ion-color-light);
  padding: 8px;
  border-radius: 6px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
