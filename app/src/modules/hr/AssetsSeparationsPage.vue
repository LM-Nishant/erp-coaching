<template>
  <AppPage title="Assets & exits" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="assets">Assets</ion-segment-button>
      <ion-segment-button value="exits">Resignations & exits</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'assets'">
      <ion-list>
        <ion-item v-for="a in assets" :key="a.id">
          <ion-label>
            <h3>
              {{ a.name }} <span v-if="a.assetTag">({{ a.assetTag }})</span>
            </h3>
            <p>
              {{ nameOf(a.employeeId) }} · issued {{ a.issuedOn
              }}<span v-if="a.returnedOn"> · returned {{ a.returnedOn }}</span>
            </p>
          </ion-label>
          <ion-badge
            slot="end"
            :color="a.status === 'issued' ? 'warning' : a.status === 'lost' ? 'danger' : 'success'"
          >
            {{ a.status }}
          </ion-badge>
          <template v-if="a.status === 'issued'">
            <ion-button slot="end" v-can="'hr.edit'" fill="clear" @click="setAsset(a.id, 'returned')"
              >Returned</ion-button
            >
            <ion-button
              slot="end"
              v-can="'hr.edit'"
              fill="clear"
              color="danger"
              @click="setAsset(a.id, 'lost')"
              >Lost</ion-button
            >
          </template>
        </ion-item>
        <ion-item v-if="!assets.length"><ion-label class="muted">No assets issued.</ion-label></ion-item>
      </ion-list>
      <form v-can="'hr.edit'" @submit.prevent="addAsset">
        <ion-list>
          <ion-list-header>Issue asset</ion-list-header>
          <ion-item>
            <ion-select v-model="assetForm.employeeId" label="Employee" label-placement="stacked">
              <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                e.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input v-model="assetForm.name" label="Asset" label-placement="stacked" required
          /></ion-item>
          <ion-item
            ><ion-input v-model="assetForm.assetTag" label="Tag / serial" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="assetForm.issuedOn" type="date" label="Issued on" label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="assetValue"
              type="number"
              label="Value (₹, recovered if not returned)"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">Issue</ion-button>
      </form>
    </template>

    <template v-else>
      <ion-list>
        <ion-item v-for="s in separations" :key="s.id">
          <ion-label class="ion-text-wrap">
            <h3>{{ s.employee?.name }} · {{ s.type }}</h3>
            <p>
              Submitted {{ s.submittedOn }} · last day {{ s.lastWorkingDay }} · notice
              {{ s.noticePeriodDays }} days
            </p>
            <p v-if="s.reason">{{ s.reason }}</p>
          </ion-label>
          <ion-badge slot="end">{{ s.status }}</ion-badge>
          <template v-if="s.status === 'submitted'">
            <ion-button slot="end" v-can="'hr.approve'" fill="clear" @click="transition(s, 'accept')"
              >Accept</ion-button
            >
            <ion-button
              slot="end"
              v-can="'hr.approve'"
              fill="clear"
              color="danger"
              @click="transition(s, 'reject')"
            >
              Reject
            </ion-button>
          </template>
          <ion-button
            v-if="s.status === 'accepted'"
            slot="end"
            v-can="'hr.approve'"
            fill="clear"
            @click="transition(s, 'complete')"
            >Complete exit</ion-button
          >
        </ion-item>
        <ion-item v-if="!separations.length"><ion-label class="muted">No separations.</ion-label></ion-item>
      </ion-list>
      <form v-can="'hr.create'" @submit.prevent="addSeparation">
        <ion-list>
          <ion-list-header>Record resignation / termination</ion-list-header>
          <ion-item>
            <ion-select v-model="sepForm.employeeId" label="Employee" label-placement="stacked">
              <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                e.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="sepForm.type" label="Type" label-placement="stacked">
              <ion-select-option value="resignation">Resignation</ion-select-option>
              <ion-select-option value="termination">Termination</ion-select-option>
              <ion-select-option value="retirement">Retirement</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input
              v-model="sepForm.submittedOn"
              type="date"
              label="Submitted on"
              label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="sepForm.lastWorkingDay"
              type="date"
              label="Last working day (blank = per notice)"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item
            ><ion-textarea v-model="sepForm.reason" label="Reason" label-placement="stacked" auto-grow
          /></ion-item>
        </ion-list>
        <ion-button expand="block" type="submit">Save</ion-button>
      </form>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
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
import type { AssetStatus, EmployeeDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { blankToNull, hrApi, todayIso, type Asset, type Separation } from './api';

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
    await toast('Asset issued');
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
    await toast('Saved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function transition(s: Separation, t: 'accept' | 'reject' | 'complete') {
  if (t !== 'accept') return hrApi.transitionSeparation(s.id, t).then(load).catch(toastError);
  const alert = await alertController.create({
    header: 'Accept resignation',
    inputs: [{ name: 'lwd', type: 'date', value: s.lastWorkingDay }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Accept',
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
