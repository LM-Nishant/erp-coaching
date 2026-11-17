<template>
  <ion-item button :router-link="`/question-bank/questions/${question.id}`" detail>
    <ion-label class="ion-text-wrap">
      <p>
        <ion-badge color="primary">{{ QUESTION_TYPE_LABELS[question.type] }}</ion-badge>
        <ion-badge :color="DIFFICULTY_COLORS[question.difficulty]">{{ question.difficulty }}</ion-badge>
        <ion-badge :color="STATUS_COLORS[question.status]">{{ question.status }}</ion-badge>
        <ion-badge v-if="question.source === 'ai'" color="tertiary">AI</ion-badge>
      </p>
      <h3>{{ snippet(question.text) }}</h3>
      <p v-if="question.chapterName || question.topicName">
        {{ [question.chapterName, question.topicName].filter(Boolean).join(' › ') }}
      </p>
      <p v-if="question.tags.length">
        <ion-chip v-for="t in question.tags" :key="t" outline>{{ t }}</ion-chip>
      </p>
    </ion-label>
    <ion-note slot="end">{{ question.defaultMarks }} m</ion-note>
  </ion-item>
</template>

<script setup lang="ts">
import { IonBadge, IonChip, IonItem, IonLabel, IonNote } from '@ionic/vue';
import { QUESTION_TYPE_LABELS, type QuestionDto } from '@erp/shared';
import { DIFFICULTY_COLORS, STATUS_COLORS, snippet } from './helpers';

defineProps<{ question: QuestionDto }>();
</script>

<style scoped>
ion-badge {
  margin-right: 4px;
  text-transform: capitalize;
}
ion-chip {
  height: 22px;
  font-size: 12px;
  margin: 2px 4px 0 0;
}
</style>
