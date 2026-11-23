<template>
  <ion-header>
    <ion-toolbar>
      <ion-title>Import from question bank</ion-title>
      <ion-buttons slot="end"><ion-button @click="emit('close')">Cancel</ion-button></ion-buttons>
    </ion-toolbar>
    <ion-toolbar>
      <ion-searchbar v-model="q" :debounce="300" placeholder="Search questions" @ion-input="load" />
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <p class="muted ion-padding-horizontal">
      Multiple-choice and true/false questions can be copied into the quiz. Later edits in the bank don't
      change the quiz.
    </p>
    <ion-list>
      <ion-item v-for="item in items" :key="item.id">
        <ion-checkbox
          slot="start"
          :checked="picked.has(item.id)"
          :aria-label="`Select question ${item.id}`"
          :data-testid="`qb-pick-${item.id}`"
          @ion-change="toggle(item.id, $event.detail.checked)"
        />
        <ion-label class="ion-text-wrap">
          <h3>{{ item.text }}</h3>
          <p>{{ QUESTION_TYPE_LABELS[item.type] }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
    <p v-if="loaded && !items.length" class="muted ion-padding">No multiple-choice questions found.</p>
  </ion-content>
  <ion-footer>
    <ion-toolbar>
      <ion-button
        expand="block"
        class="ion-padding-horizontal"
        :disabled="busy || !picked.size"
        data-testid="qb-import"
        @click="emit('pick', [...picked])"
        >Add {{ picked.size || '' }} question{{ picked.size === 1 ? '' : 's' }}</ion-button
      >
    </ion-toolbar>
  </ion-footer>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonFooter,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { QUESTION_TYPE_LABELS, type QuestionDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { questionBankApi } from '../../question-bank/api';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ close: []; pick: [number[]] }>();
const IMPORTABLE = new Set(['single', 'multiple', 'true_false']);

const q = ref('');
const items = ref<QuestionDto[]>([]);
const picked = reactive(new Set<number>());
const loaded = ref(false);

function toggle(id: number, on: boolean) {
  if (on) picked.add(id);
  else picked.delete(id);
}

async function load() {
  try {
    const page = await questionBankApi.questions({ q: q.value || undefined, pageSize: 50 });
    items.value = page.items.filter((x) => IMPORTABLE.has(x.type));
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
  font-size: 13px;
}
</style>
