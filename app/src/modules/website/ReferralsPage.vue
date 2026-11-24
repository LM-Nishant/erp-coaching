<template>
  <AppPage :title="t('website.referrals.title')" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="auth.can('website.create')"
        :aria-label="t('website.referrals.new')"
        @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <div class="stats">
      <StatCard :label="t('website.referrals.clicks')" :value="formatNumber(totals.clicks)" />
      <StatCard :label="t('website.referrals.signupsEnquiries')" :value="formatNumber(totals.signups)" />
      <StatCard :label="t('website.referrals.purchases')" :value="formatNumber(totals.purchases)" />
    </div>
    <ion-list>
      <ion-item v-for="r in items" :key="r.id" button :detail="false" @click="openEditor(r)">
        <ion-label class="ion-text-wrap">
          <h2>
            <strong>{{ r.code }}</strong> — {{ r.name }}
            <StatusChip v-if="!r.isActive" :label="t('common.status.inactive')" />
          </h2>
          <p>
            {{
              t('website.referrals.stats', {
                clicks: formatNumber(r.clicks),
                signups: formatNumber(r.signups),
                purchases: formatNumber(r.purchases),
                rate: rate(r),
              })
            }}
          </p>
          <p v-if="r.commissionNote">{{ r.commissionNote }}</p>
        </ion-label>
        <ion-button
          slot="end"
          fill="clear"
          :aria-label="t('website.referrals.copyLink')"
          @click.stop="copy(r.shareUrl)"
        >
          <ion-icon slot="icon-only" :icon="copyOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!items.length" lines="none"
        ><ion-label>{{ t('website.referrals.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editing ? editing.code : t('website.referrals.new') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.code"
                :label="t('website.coupons.code')"
                label-placement="stacked"
                required
                :helper-text="t('website.referrals.codeHelp')"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.name"
                :label="t('website.referrals.name')"
                label-placement="stacked"
                required
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.commissionNote"
                :label="t('website.referrals.commissionNote')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item
              ><ion-toggle v-model="form.isActive">{{ t('common.status.active') }}</ion-toggle></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">{{
            t('common.actions.save')
          }}</ion-button>
        </form>
        <template v-if="editing">
          <ion-item lines="none">
            <ion-label class="ion-text-wrap"
              ><p>{{ t('website.referrals.shareLink', { url: editing.shareUrl }) }}</p></ion-label
            >
            <ion-button
              slot="end"
              fill="clear"
              :aria-label="t('website.referrals.copyLink')"
              @click="copy(editing.shareUrl)"
              ><ion-icon slot="icon-only" :icon="copyOutline"
            /></ion-button>
          </ion-item>
          <ion-segment :value="kind" @ion-change="setKind(String($event.detail.value))">
            <ion-segment-button value="">{{ t('common.labels.all') }}</ion-segment-button>
            <ion-segment-button value="click">{{ t('website.referrals.clicks') }}</ion-segment-button>
            <ion-segment-button value="signup">{{ t('website.referrals.signups') }}</ion-segment-button>
            <ion-segment-button value="purchase">{{ t('website.referrals.purchases') }}</ion-segment-button>
          </ion-segment>
          <ion-list>
            <ion-item v-for="e in events" :key="e.id">
              <ion-label>
                <h3>{{ kindLabel(e.kind) }}</h3>
                <p>{{ formatDateTime(e.createdAt) }}{{ e.refType ? ` · ${e.refType} #${e.refId}` : '' }}</p>
              </ion-label>
              <ion-note v-if="e.amountPaise !== null" slot="end">{{ formatMoney(e.amountPaise) }}</ion-note>
            </ion-item>
            <ion-item v-if="!events.length" lines="none"
              ><ion-label>{{ t('website.referrals.noActivity') }}</ion-label></ion-item
            >
          </ion-list>
          <ion-button
            v-if="auth.can('website.delete')"
            expand="block"
            fill="clear"
            color="danger"
            @click="remove"
            >{{ t('website.referrals.delete') }}</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add, copyOutline } from 'ionicons/icons';
import type { ReferralCodeDto, ReferralEventDto, ReferralEventKind } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { websiteApi } from './api';

const { t, te } = useI18n();
const auth = useAuthStore();
const items = ref<ReferralCodeDto[]>([]);
const form = ref<{ code: string; name: string; commissionNote: string; isActive: boolean } | null>(null);
const editing = ref<ReferralCodeDto | null>(null);
const events = ref<ReferralEventDto[]>([]);
const kind = ref('');
const saving = ref(false);

const totals = computed(() =>
  items.value.reduce(
    (sum, r) => ({
      clicks: sum.clicks + r.clicks,
      signups: sum.signups + r.signups,
      purchases: sum.purchases + r.purchases,
    }),
    { clicks: 0, signups: 0, purchases: 0 },
  ),
);
const rate = (r: ReferralCodeDto) =>
  r.clicks
    ? t('website.referrals.conversion', {
        percent: formatPercent(Math.round(((r.signups + r.purchases) / r.clicks) * 100)),
      })
    : t('website.referrals.noClicks');
const kindLabel = (k: string) =>
  te(`website.referrals.kinds.${k}`, 'en') ? t(`website.referrals.kinds.${k}`) : k;

async function load() {
  try {
    items.value = (await websiteApi.referrals()).items;
  } catch (e) {
    await toastError(e);
  }
}

async function loadEvents() {
  if (!editing.value) return;
  events.value = (
    await websiteApi.referralEvents(
      editing.value.id,
      (kind.value || undefined) as ReferralEventKind | undefined,
    )
  ).items;
}

async function openEditor(r?: ReferralCodeDto) {
  editing.value = r ?? null;
  kind.value = '';
  events.value = [];
  form.value = {
    code: r?.code ?? '',
    name: r?.name ?? '',
    commissionNote: r?.commissionNote ?? '',
    isActive: r?.isActive ?? true,
  };
  await loadEvents().catch(toastError);
}

async function setKind(k: string) {
  kind.value = k;
  await loadEvents().catch(toastError);
}

async function save() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  try {
    await websiteApi.saveReferral(editing.value?.id ?? null, {
      code: f.code,
      name: f.name,
      commissionNote: f.commissionNote || null,
      isActive: f.isActive,
    });
    form.value = null;
    await toast(t('website.referrals.saved'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!editing.value) return;
  try {
    await websiteApi.removeReferral(editing.value.id);
    form.value = null;
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    await toast(t('website.referrals.linkCopied'));
  } catch {
    await toast(url, 'medium');
  }
}

onMounted(load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
</style>
