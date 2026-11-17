<template>
  <AppPage title="New complaint" back-href="/grievances/my">
    <form @submit.prevent="submit">
      <ion-list>
        <ion-item v-if="children.length">
          <ion-select v-model="form.onBehalfOfUserId" label="Filing for" label-placement="stacked">
            <ion-select-option :value="null">Myself</ion-select-option>
            <ion-select-option v-for="c in children" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.categoryId" label="Category" label-placement="stacked" required>
            <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="selectedCategory?.description">
          <ion-label class="muted">{{ selectedCategory.description }}</ion-label>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.priority" label="Priority" label-placement="stacked">
            <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{
              p
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.subject"
            label="Subject"
            label-placement="stacked"
            :maxlength="200"
            required
          />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.description"
            label="Describe the issue"
            label-placement="stacked"
            :auto-grow="true"
            :rows="5"
            :maxlength="5000"
            required
          />
        </ion-item>
        <ion-item>
          <ion-label>
            <p>Attachments (optional)</p>
            <input ref="fileInput" type="file" multiple @change="pickFiles" />
            <p v-for="f in files" :key="f.name">{{ f.name }} ({{ Math.ceil(f.size / 1024) }} KB)</p>
          </ion-label>
        </ion-item>
      </ion-list>
      <p v-if="selectedCategory" class="muted ion-padding-horizontal">
        Expected response within {{ selectedCategory.slaHours }} hours.
      </p>
      <ion-button expand="block" type="submit" :disabled="saving || !form.categoryId"
        >Submit complaint</ion-button
      >
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/vue';
import {
  GRIEVANCE_PRIORITIES,
  type CreateGrievanceInput,
  type GrievanceCategoryDto,
  type GrievanceUserRef,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { grievancesApi } from './api';

const router = useRouter();
const categories = ref<GrievanceCategoryDto[]>([]);
const children = ref<GrievanceUserRef[]>([]);
const files = ref<File[]>([]);
const saving = ref(false);
const form = reactive<CreateGrievanceInput & { categoryId: number }>({
  categoryId: 0,
  subject: '',
  description: '',
  priority: 'medium',
  onBehalfOfUserId: null,
});
const selectedCategory = computed(() => categories.value.find((c) => c.id === form.categoryId));

function pickFiles(ev: Event) {
  files.value = Array.from((ev.target as HTMLInputElement).files ?? []);
}

async function submit() {
  saving.value = true;
  try {
    const t = await grievancesApi.create({ ...form });
    const failed: string[] = [];
    for (const f of files.value) {
      await grievancesApi.attach(t.id, f).catch(() => failed.push(f.name));
    }
    await toast(
      failed.length
        ? `Complaint ${t.ticketNumber} submitted, but these files failed: ${failed.join(', ')}`
        : `Complaint ${t.ticketNumber} submitted`,
    );
    await router.replace(`/grievances/${t.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const [cats, kids] = await Promise.all([grievancesApi.categories(), grievancesApi.linkedStudents()]);
    categories.value = cats;
    children.value = kids;
    if (cats.length) form.categoryId = cats[0]!.id;
  } catch (e) {
    await toastError(e);
  }
});
</script>
