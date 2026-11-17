<template>
  <AppPage title="Classrooms" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'academics.create'" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-item lines="none">
      <ion-select v-model="branchFilter" label="Branch" interface="popover" @ion-change="load">
        <ion-select-option :value="null">All branches</ion-select-option>
        <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
      </ion-select>
    </ion-item>

    <ion-list>
      <ion-item v-for="c in rooms" :key="c.id">
        <ion-label>
          <h2>
            {{ c.name }}
            <ion-badge v-if="c.isVirtual" color="tertiary">virtual</ion-badge>
            <ion-badge v-if="c.status !== 'active'" color="medium">{{ c.status }}</ion-badge>
          </h2>
          <p>{{ branchName(c.branchId) }} · capacity {{ c.capacity }}</p>
        </ion-label>
        <ion-button slot="end" v-can="'academics.edit'" fill="clear" @click="openEditor(c)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button slot="end" v-can="'academics.delete'" fill="clear" color="danger" @click="remove(c)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
      <ion-item v-if="!loading && !rooms.length"
        ><ion-label class="muted">No classrooms yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit classroom' : 'New classroom' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-select v-model="form.branchId" label="Branch" label-placement="stacked">
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model.number="form.capacity"
                type="number"
                min="1"
                label="Capacity"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item><ion-toggle v-model="form.isVirtual">Virtual / online room</ion-toggle></ion-item>
            <ion-item>
              <ion-select v-model="form.status" label="Status" label-placement="stacked">
                <ion-select-option value="active">Active</ion-select-option>
                <ion-select-option value="inactive">Inactive</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving || !form.branchId">Save</ion-button>
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
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import type { ClassroomDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi, type BranchRef } from './api';

type Form = Omit<ClassroomDto, 'id' | 'branchId'> & { branchId: number | null };

const rooms = ref<ClassroomDto[]>([]);
const branches = ref<BranchRef[]>([]);
const branchFilter = ref<number | null>(null);
const loading = ref(true);
const saving = ref(false);
const editingId = ref<number | null>(null);
const form = ref<Form | null>(null);

const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name ?? `#${id}`;

async function load() {
  loading.value = true;
  try {
    if (!branches.value.length) branches.value = await academicsApi.branches();
    rooms.value = await academicsApi.classrooms({ branchId: branchFilter.value });
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(c?: ClassroomDto) {
  editingId.value = c?.id ?? null;
  form.value = {
    branchId: c?.branchId ?? branchFilter.value ?? branches.value[0]?.id ?? null,
    name: c?.name ?? '',
    capacity: c?.capacity ?? 30,
    isVirtual: c?.isVirtual ?? false,
    status: c?.status ?? 'active',
  };
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await academicsApi.saveClassroom(
      { ...form.value, capacity: Number(form.value.capacity) },
      editingId.value ?? undefined,
    );
    form.value = null;
    await toast('Classroom saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(c: ClassroomDto) {
  const alert = await alertController.create({
    header: `Delete ${c.name}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => academicsApi.removeClassroom(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
