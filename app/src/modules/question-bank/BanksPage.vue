<template>
  <AppPage title="Question bank" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'question-bank.create'" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="300" placeholder="Search banks" />
    <ion-item v-if="subjects.length">
      <ion-select v-model="subjectFilter" label="Subject" interface="popover">
        <ion-select-option :value="null">All subjects</ion-select-option>
        <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</ion-select-option>
      </ion-select>
    </ion-item>

    <ion-list>
      <ion-item v-for="b in banks" :key="b.id" button :router-link="`/question-bank/banks/${b.id}`" detail>
        <ion-icon slot="start" :icon="b.visibility === 'shared' ? peopleOutline : lockClosedOutline" />
        <ion-label class="ion-text-wrap">
          <h2>{{ b.name }}</h2>
          <p>
            {{ b.questionCount ?? 0 }} questions
            <template v-if="b.subjectName"> · {{ b.subjectName }}</template>
            <template v-if="b.ownerName"> · {{ b.ownerName }}</template>
          </p>
          <p v-if="b.description">{{ b.description }}</p>
        </ion-label>
        <template v-if="b.canEdit">
          <ion-button slot="end" v-can="'question-bank.edit'" fill="clear" @click.stop.prevent="openEditor(b)"
            ><ion-icon slot="icon-only" :icon="createOutline"
          /></ion-button>
          <ion-button
            slot="end"
            v-can="'question-bank.delete'"
            fill="clear"
            color="danger"
            @click.stop.prevent="remove(b)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </template>
      </ion-item>
      <ion-item v-if="!loading && !banks.length">
        <ion-label class="muted">No question banks yet.</ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit bank' : 'New bank' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-textarea
                v-model="form.description"
                label="Description"
                label-placement="stacked"
                :auto-grow="true"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.subjectId"
                label="Subject"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
                  s.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.visibility"
                label="Visibility"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option value="private">Private (only me and bank managers)</ion-select-option>
                <ion-select-option value="shared">Shared with all staff</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add, createOutline, lockClosedOutline, peopleOutline, trashOutline } from 'ionicons/icons';
import type { BankVisibility, QuestionBankDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { questionBankApi } from './api';
import { useAcademicPickers } from './helpers';

interface BankForm {
  name: string;
  description: string;
  subjectId: number | null;
  visibility: BankVisibility;
}

const banks = ref<QuestionBankDto[]>([]);
const search = ref('');
const subjectFilter = ref<number | null>(null);
const loading = ref(true);
const form = ref<BankForm | null>(null);
const editingId = ref<number | null>(null);
const saving = ref(false);
const { subjects, loadSubjects } = useAcademicPickers();

async function load() {
  loading.value = true;
  try {
    banks.value = await questionBankApi.banks({
      q: search.value || undefined,
      subjectId: subjectFilter.value ?? undefined,
    });
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(b?: QuestionBankDto) {
  editingId.value = b?.id ?? null;
  form.value = {
    name: b?.name ?? '',
    description: b?.description ?? '',
    subjectId: b?.subjectId ?? subjectFilter.value,
    visibility: b?.visibility ?? 'private',
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await questionBankApi.saveBank(
      { ...form.value, description: form.value.description.trim() || null },
      editingId.value ?? undefined,
    );
    form.value = null;
    await toast('Saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(b: QuestionBankDto) {
  const alert = await alertController.create({
    header: `Delete ${b.name}?`,
    message: 'Only empty banks can be deleted. Move or delete the questions first.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => questionBankApi.removeBank(b.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

watch([search, subjectFilter], load);
onIonViewWillEnter(() => {
  void loadSubjects();
  void load();
});
</script>
