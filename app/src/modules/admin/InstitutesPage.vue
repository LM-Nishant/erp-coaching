<template>
  <AppPage :title="t('admin.institutes.title')" :on-refresh="load">
    <template #actions>
      <ion-button :aria-label="t('admin.institutes.new')" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar
      v-model="search"
      :debounce="400"
      :placeholder="t('admin.institutes.searchPlaceholder')"
      @ion-input="load"
    />
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="">{{ t('common.labels.all') }}</ion-segment-button>
      <ion-segment-button value="active">{{ statusLabel('active') }}</ion-segment-button>
      <ion-segment-button value="suspended">{{ statusLabel('suspended') }}</ion-segment-button>
      <ion-segment-button value="inactive">{{ statusLabel('inactive') }}</ion-segment-button>
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
            {{
              i.subscription
                ? t('admin.institutes.planStatus', {
                    plan: i.subscription.plan.name,
                    status: statusLabel(i.subscription.status),
                  })
                : t('admin.institutes.noPlan')
            }}
          </p>
        </ion-label>
        <StatusChip slot="end" :label="statusLabel(i.status)" :tone="statusTone[i.status]" />
      </ion-item>
    </ion-list>
    <p v-if="loaded && !rows.length" class="muted">{{ t('admin.institutes.empty') }}</p>
    <p class="muted">{{ t('admin.institutes.count', { n: formatNumber(total) }, total) }}</p>

    <InstituteEditModal
      :institute-id="editingId"
      @close="editingId = null"
      @saved="((editingId = null), load())"
    />

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('admin.institutes.new') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="create">
          <ion-list>
            <ion-list-header>{{ t('admin.institutes.sectionInstitute') }}</ion-list-header>
            <ion-item
              ><ion-input
                v-model="form.name"
                :label="t('common.labels.name')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.slug"
                :label="t('admin.institutes.slug')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.city" :label="t('admin.institutes.city')" label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="form.planId"
                :label="t('admin.institutes.plan')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="p in plans" :key="p.id" :value="p.id">{{
                  p.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><label class="color"
                >{{ t('admin.institutes.primaryColour') }}
                <input v-model="form.primaryColor" type="color" /></label
            ></ion-item>
            <ion-list-header>{{ t('admin.institutes.sectionAdmin') }}</ion-list-header>
            <ion-item
              ><ion-input
                v-model="form.admin.name"
                :label="t('common.labels.name')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.admin.mobile"
                :label="t('admin.institutes.mobile')"
                label-placement="stacked"
                type="tel"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.admin.password"
                :label="t('admin.institutes.password')"
                label-placement="stacked"
                type="password"
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">{{
            t('common.actions.create')
          }}</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonAvatar,
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
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import InstituteEditModal from './components/InstituteEditModal.vue';
import { useAuthStore } from '@/stores/auth';
import { adminApi, statusLabel, type CreateInstituteInput, type InstituteRow, type PlanDto } from './api';

const { t } = useI18n();
const auth = useAuthStore();
const loaded = ref(false);
const router = useRouter();
const rows = ref<InstituteRow[]>([]);
const total = ref(0);
const search = ref('');
const status = ref('');
const plans = ref<PlanDto[]>([]);
const form = ref<(CreateInstituteInput & { admin: { password: string } }) | null>(null);
const busy = ref(false);
const editingId = ref<number | null>(null);
const statusTone: Record<InstituteStatus, 'success' | 'danger' | 'medium'> = {
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
  } finally {
    loaded.value = true;
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
    await toast(t('admin.institutes.created'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

const STATUS_ACTIONS: Record<InstituteStatus, { action: string; needsReason: boolean }> = {
  active: { action: 'activate', needsReason: false },
  suspended: { action: 'suspend', needsReason: true },
  inactive: { action: 'deactivate', needsReason: true },
};
const verb = (s: InstituteStatus) => t(`admin.institutes.actions.${STATUS_ACTIONS[s].action}`);

async function changeStatus(i: InstituteRow, next: InstituteStatus) {
  const a = STATUS_ACTIONS[next];
  const alert = await alertController.create({
    header: t('admin.institutes.confirmStatus', { action: verb(next), name: i.name }),
    message: t(`admin.institutes.notes.${a.action}`),
    inputs: [
      {
        name: 'reason',
        type: 'textarea',
        placeholder: a.needsReason
          ? t('admin.institutes.reasonRequired')
          : t('admin.institutes.reasonOptional'),
        attributes: { maxlength: 255 },
      },
    ],
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: verb(next),
        role: next === 'active' ? undefined : 'destructive',
        handler: (v: { reason?: string }) => {
          const reason = v.reason?.trim() ?? '';
          if (a.needsReason && reason.length < 3) {
            void toast(t('admin.institutes.enterReason'), 'warning');
            return false;
          }
          adminApi
            .setStatus(i.id, next, reason || undefined)
            .then(() => toast(t('admin.institutes.nowStatus', { name: i.name, status: statusLabel(next) })))
            .then(load)
            .catch(toastError);
          return true;
        },
      },
    ],
  });
  await alert.present();
}

async function impersonate(i: InstituteRow) {
  const admins = await adminApi.admins(i.id);
  const alert = await alertController.create({
    header: t('admin.institutes.impersonateTitle', { name: i.name }),
    message: t('admin.institutes.impersonateNote'),
    inputs: [
      ...admins.map((a, idx) => ({
        type: 'radio' as const,
        label: `${a.name} (${a.mobile})`,
        value: a.id,
        checked: idx === 0,
      })),
    ],
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('admin.institutes.start'),
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
    header: t('admin.institutes.changePlanTitle', { name: i.name }),
    inputs: plans.value.map((p) => ({
      type: 'radio' as const,
      label: p.name,
      value: p.id,
      checked: p.id === i.subscription?.plan.id,
    })),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('admin.institutes.apply'),
        handler: (planId: number) => adminApi.changePlan(i.id, planId).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

/** A closed (inactive) institute can only be reopened; otherwise any other status. */
const nextStatuses = (current: InstituteStatus): InstituteStatus[] =>
  current === 'inactive'
    ? ['active']
    : (['active', 'suspended', 'inactive'] as const).filter((s) => s !== current);

async function actions(i: InstituteRow) {
  const sheet = await actionSheetController.create({
    header: i.name,
    buttons: [
      {
        text: t('admin.institutes.actions.billing'),
        handler: () => void router.push(`/admin/billing/institutes/${i.id}`),
      },
      { text: t('admin.institutes.actions.edit'), handler: () => void (editingId.value = i.id) },
      {
        text: t('admin.institutes.actions.impersonate'),
        handler: () => void impersonate(i).catch(toastError),
      },
      { text: t('admin.institutes.actions.changePlan'), handler: () => void changePlan(i).catch(toastError) },
      {
        text: t('admin.institutes.actions.data'),
        handler: () => void router.push(`/admin/data/institutes/${i.id}`),
      },
      ...nextStatuses(i.status).map((s) => ({
        text: verb(s),
        role: s === 'active' ? undefined : 'destructive',
        handler: () => void changeStatus(i, s).catch(toastError),
      })),
      { text: t('common.actions.cancel'), role: 'cancel' },
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
