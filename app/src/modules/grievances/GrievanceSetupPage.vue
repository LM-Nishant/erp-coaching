<template>
  <AppPage title="Grievance setup" :on-refresh="load">
    <ion-list v-if="settings">
      <ion-list-header><ion-label>Settings</ion-label></ion-list-header>
      <ion-item>
        <ion-input
          v-model="settings.ticketPrefix"
          label="Ticket number prefix"
          label-placement="stacked"
          helper-text="2–10 letters/digits, e.g. GRV → GRV-2026-00001"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="settings.defaultSlaHours"
          type="number"
          label="Default SLA (hours)"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="settings.escalationUserId"
          label="Escalate overdue complaints to"
          label-placement="stacked"
          interface="popover"
        >
          <ion-select-option :value="null">Keep current assignee</ion-select-option>
          <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{ a.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-button expand="block" :disabled="saving" @click="saveSettings">Save settings</ion-button>
    </ion-list>

    <ion-list>
      <ion-list-header>
        <ion-label>Categories</ion-label>
        <ion-button @click="openEditor()"><ion-icon slot="icon-only" :icon="add" /></ion-button>
      </ion-list-header>
      <ion-item v-for="c in categories" :key="c.id">
        <ion-label>
          <h2>{{ c.name }} <ion-badge v-if="!c.isActive" color="medium">inactive</ion-badge></h2>
          <p>SLA {{ c.slaHours }} h · {{ c.defaultAssigneeName ?? 'No default assignee' }}</p>
          <p v-if="c.description">{{ c.description }}</p>
        </ion-label>
        <ion-button slot="end" fill="clear" @click="openEditor(c)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button slot="end" fill="clear" color="danger" @click="remove(c)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit category' : 'New category' }}</ion-title>
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
              <ion-input
                v-model.number="form.slaHours"
                type="number"
                label="SLA (hours)"
                label-placement="stacked"
                min="1"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.defaultAssigneeUserId"
                label="Default assignee"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">None</ion-select-option>
                <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{
                  a.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item><ion-toggle v-model="form.isActive">Active</ion-toggle></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type {
  GrievanceCategoryDto,
  GrievanceCategoryInput,
  GrievanceSettingsDto,
  GrievanceUserRef,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { grievancesApi } from './api';

const settings = ref<GrievanceSettingsDto | null>(null);
const categories = ref<GrievanceCategoryDto[]>([]);
const assignees = ref<GrievanceUserRef[]>([]);
const form = ref<Required<GrievanceCategoryInput> | null>(null);
const editingId = ref<number | null>(null);
const saving = ref(false);

async function load() {
  try {
    const [s, c, a] = await Promise.all([
      grievancesApi.settings(),
      grievancesApi.categories(true),
      grievancesApi.assignees(),
    ]);
    settings.value = s;
    categories.value = c;
    assignees.value = a;
  } catch (e) {
    await toastError(e);
  }
}

async function saveSettings() {
  if (!settings.value) return;
  saving.value = true;
  try {
    settings.value = await grievancesApi.saveSettings({
      ...settings.value,
      defaultSlaHours: Number(settings.value.defaultSlaHours),
    });
    await toast('Settings saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

function openEditor(c?: GrievanceCategoryDto) {
  editingId.value = c?.id ?? null;
  form.value = {
    name: c?.name ?? '',
    description: c?.description ?? '',
    slaHours: c?.slaHours ?? settings.value?.defaultSlaHours ?? 72,
    defaultAssigneeUserId: c?.defaultAssigneeUserId ?? null,
    isActive: c?.isActive ?? true,
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  const body = {
    ...form.value,
    description: form.value.description || null,
    slaHours: Number(form.value.slaHours),
  };
  try {
    if (editingId.value) await grievancesApi.updateCategory(editingId.value, body);
    else await grievancesApi.createCategory(body);
    form.value = null;
    await toast('Category saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(c: GrievanceCategoryDto) {
  const alert = await alertController.create({
    header: `Delete ${c.name}?`,
    message: 'Categories already used by complaints cannot be deleted; deactivate them instead.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => grievancesApi.removeCategory(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
