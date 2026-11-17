<template>
  <AppPage title="Referrals & affiliates" :on-refresh="load">
    <template #actions>
      <ion-button v-if="auth.can('website.create')" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <div class="stats">
      <StatCard label="Clicks" :value="totals.clicks" />
      <StatCard label="Sign-ups / enquiries" :value="totals.signups" />
      <StatCard label="Purchases" :value="totals.purchases" />
    </div>
    <ion-list>
      <ion-item v-for="r in items" :key="r.id" button :detail="false" @click="openEditor(r)">
        <ion-label class="ion-text-wrap">
          <h2>
            <strong>{{ r.code }}</strong> — {{ r.name }}
            <ion-badge v-if="!r.isActive" color="medium">inactive</ion-badge>
          </h2>
          <p>
            {{ r.clicks }} clicks · {{ r.signups }} sign-ups · {{ r.purchases }} purchases · {{ rate(r) }}
          </p>
          <p v-if="r.commissionNote">{{ r.commissionNote }}</p>
        </ion-label>
        <ion-button slot="end" fill="clear" @click.stop="copy(r.shareUrl)">
          <ion-icon slot="icon-only" :icon="copyOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!items.length" lines="none"><ion-label>No referral codes yet.</ion-label></ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editing ? editing.code : 'New referral code' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.code"
                label="Code"
                label-placement="stacked"
                required
                helper-text="e.g. RAHUL10"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.name"
                label="Referrer / affiliate name"
                label-placement="stacked"
                required
              />
            </ion-item>
            <ion-item>
              <ion-input v-model="form.commissionNote" label="Commission note" label-placement="stacked" />
            </ion-item>
            <ion-item><ion-toggle v-model="form.isActive">Active</ion-toggle></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
        <template v-if="editing">
          <ion-item lines="none">
            <ion-label class="ion-text-wrap"
              ><p>Share link: {{ editing.shareUrl }}</p></ion-label
            >
            <ion-button slot="end" fill="clear" @click="copy(editing.shareUrl)"
              ><ion-icon slot="icon-only" :icon="copyOutline"
            /></ion-button>
          </ion-item>
          <ion-segment :value="kind" @ion-change="setKind(String($event.detail.value))">
            <ion-segment-button value="">All</ion-segment-button>
            <ion-segment-button value="click">Clicks</ion-segment-button>
            <ion-segment-button value="signup">Sign-ups</ion-segment-button>
            <ion-segment-button value="purchase">Purchases</ion-segment-button>
          </ion-segment>
          <ion-list>
            <ion-item v-for="e in events" :key="e.id">
              <ion-label>
                <h3>{{ e.kind }}</h3>
                <p>
                  {{ new Date(e.createdAt).toLocaleString()
                  }}{{ e.refType ? ` · ${e.refType} #${e.refId}` : '' }}
                </p>
              </ion-label>
              <ion-note v-if="e.amountPaise !== null" slot="end"
                >₹{{ (e.amountPaise / 100).toLocaleString('en-IN') }}</ion-note
              >
            </ion-item>
            <ion-item v-if="!events.length" lines="none"><ion-label>No activity yet.</ion-label></ion-item>
          </ion-list>
          <ion-button
            v-if="auth.can('website.delete')"
            expand="block"
            fill="clear"
            color="danger"
            @click="remove"
            >Delete code</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { websiteApi } from './api';

const auth = useAuthStore();
const items = ref<ReferralCodeDto[]>([]);
const form = ref<{ code: string; name: string; commissionNote: string; isActive: boolean } | null>(null);
const editing = ref<ReferralCodeDto | null>(null);
const events = ref<ReferralEventDto[]>([]);
const kind = ref('');
const saving = ref(false);

const totals = computed(() =>
  items.value.reduce(
    (t, r) => ({
      clicks: t.clicks + r.clicks,
      signups: t.signups + r.signups,
      purchases: t.purchases + r.purchases,
    }),
    { clicks: 0, signups: 0, purchases: 0 },
  ),
);
const rate = (r: ReferralCodeDto) =>
  r.clicks ? `${Math.round(((r.signups + r.purchases) / r.clicks) * 100)}% conversion` : 'no clicks yet';

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
    await toast('Referral code saved');
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
    await toast('Link copied');
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
