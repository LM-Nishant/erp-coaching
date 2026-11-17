<template>
  <AppPage title="Institutes" :on-refresh="load">
    <template #actions>
      <ion-button @click="openCreate"><ion-icon slot="icon-only" :icon="add" /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="400" placeholder="Search name or slug" @ion-input="load" />
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="">All</ion-segment-button>
      <ion-segment-button value="active">Active</ion-segment-button>
      <ion-segment-button value="suspended">Suspended</ion-segment-button>
      <ion-segment-button value="inactive">Inactive</ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-for="i in rows" :key="i.id" button @click="actions(i)">
        <ion-avatar
          slot="start"
          :style="{ background: i.branding.primaryColor ?? 'var(--ion-color-primary)' }"
        >
          <img v-if="i.branding.logoUrl" :src="i.branding.logoUrl" alt="" />
          <span v-else class="initial">{{ i.name[0] }}</span>
        </ion-avatar>
        <ion-label>
          <h2>{{ i.name }}</h2>
          <p>
            {{ i.slug }} · {{ i.city ?? '—' }} ·
            {{ i.subscription ? `${i.subscription.plan.name} (${i.subscription.status})` : 'no plan' }}
          </p>
        </ion-label>
        <ion-badge slot="end" :color="statusColor[i.status]">{{ i.status }}</ion-badge>
      </ion-item>
    </ion-list>
    <p class="muted">{{ total }} institute(s)</p>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>New institute</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="create">
          <ion-list>
            <ion-list-header>Institute</ion-list-header>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.slug" label="Slug (URL id)" label-placement="stacked" required
            /></ion-item>
            <ion-item><ion-input v-model="form.city" label="City" label-placement="stacked" /></ion-item>
            <ion-item>
              <ion-select v-model="form.planId" label="Plan" label-placement="stacked" interface="popover">
                <ion-select-option v-for="p in plans" :key="p.id" :value="p.id">{{
                  p.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><label class="color">Primary colour <input v-model="form.primaryColor" type="color" /></label
            ></ion-item>
            <ion-list-header>Institute admin</ion-list-header>
            <ion-item
              ><ion-input v-model="form.admin.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.admin.mobile"
                label="Mobile"
                label-placement="stacked"
                type="tel"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.admin.password"
                label="Initial password (optional, OTP login works without)"
                label-placement="stacked"
                type="password"
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Create</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonAvatar,
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
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  actionSheetController,
  alertController,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { InstituteStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { adminApi, type CreateInstituteInput, type InstituteRow, type PlanDto } from './api';

const auth = useAuthStore();
const router = useRouter();
const rows = ref<InstituteRow[]>([]);
const total = ref(0);
const search = ref('');
const status = ref('');
const plans = ref<PlanDto[]>([]);
const form = ref<(CreateInstituteInput & { admin: { password: string } }) | null>(null);
const busy = ref(false);
const statusColor: Record<InstituteStatus, string> = {
  active: 'success',
  suspended: 'danger',
  inactive: 'medium',
};

async function load() {
  try {
    const res = await adminApi.institutes({
      search: search.value || undefined,
      status: status.value || undefined,
    });
    rows.value = res.items;
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  }
}

async function openCreate() {
  if (!plans.value.length) plans.value = await adminApi.plans();
  form.value = {
    name: '',
    slug: '',
    city: '',
    planId: plans.value[0]?.id ?? 0,
    primaryColor: '#1E5EFF',
    admin: { name: '', mobile: '', password: '' },
  };
}

async function create() {
  if (!form.value) return;
  busy.value = true;
  const { admin, ...rest } = form.value;
  try {
    await adminApi.createInstitute({
      ...rest,
      city: rest.city || null,
      admin: { name: admin.name, mobile: admin.mobile, password: admin.password || undefined },
    });
    form.value = null;
    await toast('Institute created');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function setStatus(i: InstituteRow, next: InstituteStatus) {
  await adminApi.setStatus(i.id, next);
  await toast(`${i.name} is now ${next}`);
  await load();
}

async function impersonate(i: InstituteRow) {
  const admins = await adminApi.admins(i.id);
  const alert = await alertController.create({
    header: `Impersonate in ${i.name}`,
    message: 'The session is time-limited and every action is audited.',
    inputs: [
      ...admins.map((a, idx) => ({
        type: 'radio' as const,
        label: `${a.name} (${a.mobile})`,
        value: a.id,
        checked: idx === 0,
      })),
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Start',
        handler: (userId?: number) => {
          auth
            .impersonate(i.id, userId, 'Support via admin console')
            .then(() => router.replace('/home'))
            .catch(toastError);
        },
      },
    ],
  });
  await alert.present();
}

async function changePlan(i: InstituteRow) {
  if (!plans.value.length) plans.value = await adminApi.plans();
  const alert = await alertController.create({
    header: `Change plan for ${i.name}`,
    inputs: plans.value.map((p) => ({
      type: 'radio' as const,
      label: p.name,
      value: p.id,
      checked: p.id === i.subscription?.plan.id,
    })),
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Apply',
        handler: (planId: number) => adminApi.changePlan(i.id, planId).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function actions(i: InstituteRow) {
  const sheet = await actionSheetController.create({
    header: i.name,
    buttons: [
      { text: 'Impersonate admin', handler: () => void impersonate(i).catch(toastError) },
      { text: 'Change plan', handler: () => void changePlan(i).catch(toastError) },
      i.status === 'active'
        ? {
            text: 'Suspend',
            role: 'destructive',
            handler: () => void setStatus(i, 'suspended').catch(toastError),
          }
        : { text: 'Activate', handler: () => void setStatus(i, 'active').catch(toastError) },
      { text: 'Cancel', role: 'cancel' },
    ],
  });
  await sheet.present();
}

onMounted(load);
</script>

<style scoped>
.initial {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #fff;
  font-weight: 600;
}
.color {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
}
</style>
