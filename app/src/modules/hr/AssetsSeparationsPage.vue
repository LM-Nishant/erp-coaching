<template>
  <AppPage :title="t('hr.assets.title')" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="assets">{{ t('hr.assets.tabAssets') }}</ion-segment-button>
      <ion-segment-button value="exits">{{ t('hr.assets.tabExits') }}</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'assets'">
      <ion-list>
        <ion-item v-for="a in assets" :key="a.id">
          <ion-label>
            <h3>
              {{ a.name }} <span v-if="a.assetTag">({{ a.assetTag }})</span>
            </h3>
            <p>
              {{ nameOf(a.employeeId) }} · {{ t('hr.assets.issuedOn', { date: formatDate(a.issuedOn) })
              }}<span v-if="a.returnedOn">
                · {{ t('hr.assets.returnedOn', { date: formatDate(a.returnedOn) }) }}</span
              >
            </p>
          </ion-label>
          <StatusChip
            slot="end"
            :label="t(ASSET_STATUS[a.status].label)"
            :tone="ASSET_STATUS[a.status].tone"
          />
          <template v-if="a.status === 'issued'">
            <ion-button slot="end" v-can="'hr.edit'" fill="clear" @click="setAsset(a.id, 'returned')">{{
              t('hr.assets.markReturned')
            }}</ion-button>
            <ion-button
              slot="end"
              v-can="'hr.edit'"
              fill="clear"
              color="danger"
              @click="setAsset(a.id, 'lost')"
              >{{ t('hr.assets.markLost') }}</ion-button
            >
          </template>
        </ion-item>
        <ion-item v-if="!assets.length"
          ><ion-label class="muted">{{ t('hr.assets.empty') }}</ion-label></ion-item
        >
      </ion-list>
      <form v-can="'hr.edit'" @submit.prevent="addAsset">
        <ion-list>
          <ion-list-header>{{ t('hr.assets.issueTitle') }}</ion-list-header>
          <ion-item>
            <ion-select v-model="assetForm.employeeId" :label="t('hr.employee')" label-placement="stacked">
              <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                e.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input
              v-model="assetForm.name"
              :label="t('hr.assets.asset')"
              label-placement="stacked"
              required
          /></ion-item>
          <ion-item
            ><ion-input v-model="assetForm.assetTag" :label="t('hr.assets.tag')" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="assetForm.issuedOn"
              type="date"
              :label="t('hr.assets.issuedOnLabel')"
              label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="assetValue"
              type="number"
              :label="t('hr.assets.value')"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">{{ t('hr.assets.issue') }}</ion-button>
      </form>
    </template>

    <template v-else>
      <ion-list>
        <ion-item v-for="s in separations" :key="s.id">
          <ion-label class="ion-text-wrap">
            <h3>{{ s.employee?.name }} · {{ t(`hr.separationType.${s.type}`) }}</h3>
            <p>
              {{
                t('hr.exits.line', {
                  submitted: formatDate(s.submittedOn),
                  lastDay: formatDate(s.lastWorkingDay),
                  notice: t('hr.days', s.noticePeriodDays),
                })
              }}
            </p>
            <p v-if="s.reason">{{ s.reason }}</p>
          </ion-label>
          <StatusChip
            slot="end"
            :label="t(SEPARATION_STATUS[s.status].label)"
            :tone="SEPARATION_STATUS[s.status].tone"
          />
          <template v-if="s.status === 'submitted'">
            <ion-button slot="end" v-can="'hr.approve'" fill="clear" @click="transition(s, 'accept')">{{
              t('hr.exits.accept')
            }}</ion-button>
            <ion-button
              slot="end"
              v-can="'hr.approve'"
              fill="clear"
              color="danger"
              @click="transition(s, 'reject')"
            >
              {{ t('common.actions.reject') }}
            </ion-button>
          </template>
          <ion-button
            v-if="s.status === 'accepted'"
            slot="end"
            v-can="'hr.approve'"
            fill="clear"
            @click="transition(s, 'complete')"
            >{{ t('hr.exits.complete') }}</ion-button
          >
        </ion-item>
        <ion-item v-if="!separations.length"
          ><ion-label class="muted">{{ t('hr.exits.empty') }}</ion-label></ion-item
        >
      </ion-list>
      <form v-can="'hr.create'" @submit.prevent="addSeparation">
        <ion-list>
          <ion-list-header>{{ t('hr.exits.recordTitle') }}</ion-list-header>
          <ion-item>
            <ion-select v-model="sepForm.employeeId" :label="t('hr.employee')" label-placement="stacked">
              <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                e.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="sepForm.type" :label="t('hr.exits.type')" label-placement="stacked">
              <ion-select-option v-for="st in SEPARATION_TYPES" :key="st" :value="st">{{
                t(`hr.separationType.${st}`)
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input
              v-model="sepForm.submittedOn"
              type="date"
              :label="t('hr.exits.submittedOn')"
              label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="sepForm.lastWorkingDay"
              type="date"
              :label="t('hr.exits.lastWorkingDay')"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item
            ><ion-textarea
              v-model="sepForm.reason"
              :label="t('hr.reason')"
              label-placement="stacked"
              auto-grow
          /></ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">{{ t('common.actions.save') }}</ion-button>
      </form>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  alertController,
} from '@ionic/vue';
import type { AssetStatus, EmployeeDto, SeparationType } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import {
  ASSET_STATUS,
  SEPARATION_STATUS,
  blankToNull,
  hrApi,
  todayIso,
  type Asset,
  type Separation,
} from './api';

const { t } = useI18n();
const SEPARATION_TYPES: SeparationType[] = ['resignation', 'termination', 'retirement'];

const tab = ref('assets');
const assets = ref<Asset[]>([]);
const separations = ref<Separation[]>([]);
const employees = ref<EmployeeDto[]>([]);
const assetForm = ref<Partial<Asset>>({ issuedOn: todayIso() });
const assetValue = ref('');
const sepForm = ref<Partial<Separation>>({ type: 'resignation', submittedOn: todayIso() });

const nameOf = (id: number) => employees.value.find((e) => e.id === id)?.name ?? `#${id}`;

async function load() {
  try {
    [assets.value, separations.value, employees.value] = await Promise.all([
      hrApi.assets(),
      hrApi.separations(),
      hrApi.employees({ pageSize: 200 }).then((p) => p.items),
    ]);
  } catch (e) {
    await toastError(e);
  }
}

async function addAsset() {
  try {
    await hrApi.saveAsset({
      ...assetForm.value,
      assetTag: blankToNull(assetForm.value.assetTag) as string | null,
      valuePaise: Math.round(Number(assetValue.value || 0) * 100),
    });
    assetForm.value = { issuedOn: todayIso() };
    assetValue.value = '';
    await toast(t('hr.assets.issued'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function setAsset(id: number, status: AssetStatus) {
  await hrApi.saveAsset({ status }, id).then(load).catch(toastError);
}

async function addSeparation() {
  try {
    await hrApi.createSeparation({
      ...sepForm.value,
      lastWorkingDay: (blankToNull(sepForm.value.lastWorkingDay) as string | null) ?? undefined,
      reason: blankToNull(sepForm.value.reason) as string | null,
    });
    sepForm.value = { type: 'resignation', submittedOn: todayIso() };
    await toast(t('common.saved'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function transition(s: Separation, action: 'accept' | 'reject' | 'complete') {
  if (action !== 'accept') return hrApi.transitionSeparation(s.id, action).then(load).catch(toastError);
  const alert = await alertController.create({
    header: t('hr.exits.acceptTitle'),
    inputs: [{ name: 'lwd', type: 'date', value: s.lastWorkingDay }],
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('hr.exits.accept'),
        handler: (v: { lwd?: string }) =>
          hrApi
            .transitionSeparation(s.id, 'accept', v.lwd || undefined)
            .then(load)
            .catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
