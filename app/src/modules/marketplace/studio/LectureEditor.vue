<template>
  <ion-header>
    <ion-toolbar>
      <ion-title>{{ lecture ? 'Edit lecture' : 'Add lecture' }}</ion-title>
      <ion-buttons slot="end"><ion-button @click="emit('close')">Cancel</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content class="ion-padding">
    <ion-list>
      <ion-item>
        <ion-input
          v-model="form.title"
          label="Title"
          label-placement="stacked"
          required
          data-testid="lecture-title-input"
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="form.type"
          label="Type"
          label-placement="stacked"
          interface="popover"
          :disabled="!!lecture"
        >
          <ion-select-option value="video">Video</ion-select-option>
          <ion-select-option value="article">Article</ion-select-option>
          <ion-select-option value="resource">Downloadable resource</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.description"
          label="Short description (optional)"
          label-placement="stacked"
          auto-grow
        />
      </ion-item>
      <ion-item v-if="form.type === 'article'">
        <ion-textarea
          v-model="form.articleBody"
          label="Article"
          label-placement="stacked"
          auto-grow
          :rows="10"
          data-testid="lecture-article-input"
        />
      </ion-item>
      <ion-item v-else lines="none">
        <MediaUpload
          :scope="scope"
          :kind="form.type === 'video' ? 'video' : 'file'"
          :media="media"
          :label="form.type === 'video' ? 'Upload video' : 'Upload file'"
          testid="lecture-file"
          @uploaded="(m) => (media = m)"
        />
      </ion-item>
      <ion-item v-if="form.type !== 'video'">
        <ion-input
          v-model.number="form.minutes"
          type="number"
          min="0"
          label="Reading time (minutes)"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.preview" data-testid="lecture-preview">Free preview</ion-toggle>
      </ion-item>
    </ion-list>
    <p class="muted">
      Free preview lectures can be watched by anyone from the course page. Paid courses need at least one.
    </p>
    <ion-button expand="block" :disabled="busy || !form.title.trim()" data-testid="lecture-save" @click="save"
      >Save lecture</ion-button
    >
  </ion-content>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import type { MktLectureDto, MktLectureInput, MktLectureType, MktMediaDto } from '@erp/shared';
import MediaUpload from './MediaUpload.vue';
import type { StudioScope } from '../api';

const props = defineProps<{ scope: StudioScope; lecture: MktLectureDto | null; busy?: boolean }>();
const emit = defineEmits<{ close: []; save: [MktLectureInput] }>();
const media = ref<MktMediaDto | null>(props.lecture?.media ?? null);
const form = reactive({
  title: props.lecture?.title ?? '',
  type: (props.lecture?.type ?? 'video') as MktLectureType,
  description: props.lecture?.description ?? '',
  articleBody: props.lecture?.articleBody ?? '',
  preview: props.lecture?.preview ?? false,
  minutes:
    props.lecture && props.lecture.type !== 'video' ? Math.round(props.lecture.durationSeconds / 60) : 5,
});

function save() {
  emit('save', {
    title: form.title.trim(),
    type: form.type,
    description: form.description.trim() || null,
    articleBody: form.type === 'article' ? form.articleBody : null,
    mediaId: form.type === 'article' ? null : (media.value?.id ?? null),
    preview: form.preview,
    durationSeconds: form.type === 'video' ? undefined : Math.max(0, Number(form.minutes) || 0) * 60,
  });
}
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
  font-size: 13px;
}
</style>
