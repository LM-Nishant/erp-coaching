<template>
  <div data-testid="quiz-review">
    <div v-if="!quiz" class="center"><ion-spinner /></div>
    <template v-else>
      <p class="muted">
        {{ quiz.questions.length }} questions · pass mark {{ quiz.passPercent }}% ·
        {{ quiz.maxAttempts ? `${quiz.maxAttempts} attempts` : 'unlimited attempts' }}
      </p>
      <ol>
        <li v-for="q in quiz.questions" :key="q.id">
          <p class="prompt">
            {{ q.prompt }} <span class="muted">({{ q.kind === 'multi' ? 'several' : 'one' }})</span>
          </p>
          <ul>
            <li v-for="o in q.options" :key="o.key" :class="{ correct: q.correct.includes(o.key) }">
              {{ o.key }}. {{ o.text }}
            </li>
          </ul>
          <p v-if="q.explanation" class="muted">{{ q.explanation }}</p>
        </li>
      </ol>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonSpinner } from '@ionic/vue';
import type { MktQuizDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { quizApi } from '../quiz-api';

/** Read-only quiz with its answer key, for the platform review. */
const props = defineProps<{ courseId: number; lectureId: number }>();
const quiz = ref<MktQuizDto | null>(null);

onMounted(async () => {
  try {
    quiz.value = await quizApi.review(props.courseId, props.lectureId);
  } catch (e) {
    void toastError(e);
  }
});
</script>

<style scoped>
.prompt {
  font-weight: 600;
  margin-bottom: 4px;
}
li.correct {
  color: var(--ion-color-success-shade);
  font-weight: 600;
}
.muted {
  color: var(--ion-color-medium);
  font-weight: normal;
}
.center {
  text-align: center;
  padding: 20px;
}
</style>
