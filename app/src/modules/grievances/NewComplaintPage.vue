<template>
  <AppPage :title="t('grievances.new.title')" back-href="/grievances/my">
    <form @submit.prevent="submit">
      <ion-list>
        <ion-item v-if="children.length">
          <ion-select
            v-model="form.onBehalfOfUserId"
            :label="t('grievances.new.filingFor')"
            label-placement="stacked"
          >
            <ion-select-option :value="null">{{ t('grievances.new.myself') }}</ion-select-option>
            <ion-select-option v-for="c in children" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.categoryId"
            :label="t('grievances.fields.category')"
            label-placement="stacked"
            required
          >
            <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="selectedCategory?.description">
          <ion-label class="muted">{{ selectedCategory.description }}</ion-label>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.priority"
            :label="t('grievances.fields.priority')"
            label-placement="stacked"
          >
            <ion-select-option v-for="p in GRIEVANCE_PRIORITIES" :key="p" :value="p">{{
              t(priorityKey(p))
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.subject"
            :label="t('grievances.fields.subject')"
            label-placement="stacked"
            :maxlength="200"
            required
          />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.description"
            :label="t('grievances.new.description')"
            label-placement="stacked"
            :auto-grow="true"
            :rows="5"
            :maxlength="5000"
            required
          />
        </ion-item>
        <ion-item>
          <ion-label>
            <p>{{ t('grievances.new.attachments') }}</p>
            <input ref="fileInput" type="file" multiple @change="pickFiles" />
            <p v-for="f in files" :key="f.name">
              {{ f.name }} ({{ t('grievances.fileSize', { size: formatNumber(fileSizeKb(f.size)) }) }})
            </p>
          </ion-label>
        </ion-item>
      </ion-list>
      <p v-if="selectedCategory" class="muted ion-padding-horizontal">
        {{
          t(
            'grievances.new.expectedResponse',
            { n: formatNumber(selectedCategory.slaHours) },
            selectedCategory.slaHours,
          )
        }}
      </p>
      <ion-button expand="block" type="submit" :disabled="saving || !form.categoryId">{{
        t('grievances.new.submit')
      }}</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
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
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { fileSizeKb, grievancesApi, priorityKey } from './api';

const { t } = useI18n();
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
    const ticket = await grievancesApi.create({ ...form });
    const failed: string[] = [];
    for (const f of files.value) {
      await grievancesApi.attach(ticket.id, f).catch(() => failed.push(f.name));
    }
    await toast(
      failed.length
        ? t('grievances.new.submittedWithFailures', {
            number: ticket.ticketNumber,
            files: failed.join(', '),
          })
        : t('grievances.new.submitted', { number: ticket.ticketNumber }),
    );
    await router.replace(`/grievances/${ticket.id}`);
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
