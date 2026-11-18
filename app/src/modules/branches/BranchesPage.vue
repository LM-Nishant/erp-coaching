<template>
  <AppPage title="Branches" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'branches.create'" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-list>
      <ion-item v-for="b in branches" :key="b.id">
        <ion-label>
          <h2>
            {{ b.name }}
            <ion-badge :color="b.status === 'active' ? 'success' : 'medium'">{{ b.status }}</ion-badge>
          </h2>
          <p>{{ b.code }} · {{ [b.city, b.phone].filter(Boolean).join(' · ') }}</p>
        </ion-label>
        <ion-button slot="end" v-can="'branches.edit'" fill="clear" @click="openEditor(b)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button
          v-if="b.status === 'active'"
          slot="end"
          v-can="'branches.configure'"
          fill="clear"
          color="warning"
          :aria-label="`Close ${b.name}`"
          @click="closeBranch(b)"
          ><ion-icon slot="icon-only" :icon="lockClosedOutline"
        /></ion-button>
        <ion-button
          v-else
          slot="end"
          v-can="'branches.configure'"
          fill="clear"
          color="success"
          :aria-label="`Re-open ${b.name}`"
          @click="activateBranch(b)"
          ><ion-icon slot="icon-only" :icon="lockOpenOutline"
        /></ion-button>
        <ion-button slot="end" v-can="'branches.delete'" fill="clear" color="danger" @click="remove(b)">
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!loading && !branches.length"
        ><ion-label class="muted">No branches yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit branch' : 'New branch' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.code" label="Code" label-placement="stacked" required
            /></ion-item>
            <ion-item><ion-input v-model="form.city" label="City" label-placement="stacked" /></ion-item>
            <ion-item
              ><ion-input v-model="form.phone" label="Phone" label-placement="stacked" type="tel"
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.email" label="Email" label-placement="stacked" type="email"
            /></ion-item>
            <ion-item
              ><ion-textarea v-model="form.address" label="Address" label-placement="stacked" auto-grow
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
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
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, lockClosedOutline, lockOpenOutline, trashOutline } from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { branchesApi, type Branch, type BranchInput } from './api';

const route = useRoute();
const branches = ref<Branch[]>([]);
const loading = ref(true);
const form = ref<BranchInput | null>(null);
const editingId = ref<number | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    branches.value = await branchesApi.list();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(b?: Branch) {
  editingId.value = b?.id ?? null;
  form.value = {
    name: b?.name ?? '',
    code: b?.code ?? '',
    city: b?.city ?? '',
    phone: b?.phone ?? '',
    email: b?.email ?? '',
    address: b?.address ?? '',
  };
}

const blankToNull = (v: string | null) => (v ? v : null);

async function save() {
  if (!form.value) return;
  saving.value = true;
  const body: BranchInput = {
    ...form.value,
    city: blankToNull(form.value.city),
    phone: blankToNull(form.value.phone),
    email: blankToNull(form.value.email),
    address: blankToNull(form.value.address),
  };
  try {
    if (editingId.value) {
      const { status: _status, ...changes } = body;
      await branchesApi.update(editingId.value, changes);
    } else await branchesApi.create(body);
    form.value = null;
    await toast('Branch saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(b: Branch) {
  const alert = await alertController.create({
    header: `Delete ${b.name}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => branchesApi.remove(b.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function closeBranch(b: Branch) {
  const alert = await alertController.create({
    header: `Close ${b.name}?`,
    message:
      'A closed branch keeps its records but stops counting towards your plan. Transfer its active students first.',
    inputs: [{ name: 'reason', type: 'text', placeholder: 'Reason (optional)' }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Close branch',
        role: 'destructive',
        handler: (data: { reason?: string }) =>
          branchesApi
            .close(b.id, data.reason?.trim() || undefined)
            .then(() => toast(`${b.name} closed`))
            .then(load)
            .catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function activateBranch(b: Branch) {
  try {
    await branchesApi.activate(b.id);
    await toast(`${b.name} re-opened`);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
watch(() => route.query.b, load);
</script>
