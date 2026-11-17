<template>
  <div>
    <p class="muted">
      Choose which channels and recipients each event uses. Unchanged events use the defaults.
    </p>
    <ion-list v-for="group in groups" :key="group.category">
      <ion-list-header
        ><ion-label>{{ group.category }}</ion-label></ion-list-header
      >
      <ion-item v-for="r in group.rules" :key="r.eventKey">
        <ion-label>
          <h3>
            {{ eventLabel(r.eventKey) }}
            <ion-badge v-if="!r.isActive" color="medium">off</ion-badge>
            <ion-badge v-else-if="!r.isDefault" color="tertiary">custom</ion-badge>
          </h3>
          <p>
            {{ r.channels.map((c) => CHANNEL_LABELS[c]).join(', ') || 'No channels' }} →
            {{ r.recipientTypes.join(', ') }}
          </p>
        </ion-label>
        <ion-button slot="end" v-can="'notifications.edit'" fill="clear" @click="edit(r)">
          <ion-icon slot="icon-only" :icon="createOutline" />
        </ion-button>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ form ? eventLabel(form.eventKey) : '' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <template v-if="form">
          <ion-list>
            <ion-item><ion-toggle v-model="form.isActive">Send this notification</ion-toggle></ion-item>
            <ion-item>
              <ion-select v-model="form.channels" label="Channels" label-placement="stacked" multiple>
                <ion-select-option v-for="c in NOTIFICATION_CHANNELS" :key="c" :value="c">{{
                  CHANNEL_LABELS[c]
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.recipientTypes" label="Recipients" label-placement="stacked" multiple>
                <ion-select-option v-for="t in RECIPIENT_TYPES" :key="t" :value="t">{{
                  t
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" :disabled="saving" @click="save">Save</ion-button>
          <ion-button expand="block" fill="clear" color="medium" :disabled="saving" @click="reset"
            >Reset to default</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </div>
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
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { createOutline } from 'ionicons/icons';
import {
  NOTIFICATION_CHANNELS,
  RECIPIENT_TYPES,
  type NotificationEventDef,
  type NotificationRuleDto,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { CHANNEL_LABELS, commsApi } from '../api';

const rules = ref<NotificationRuleDto[]>([]);
const events = ref<NotificationEventDef[]>([]);
const form = ref<NotificationRuleDto | null>(null);
const saving = ref(false);

const eventLabel = (key: string) => events.value.find((e) => e.key === key)?.label ?? key;
const groups = computed(() => {
  const map = new Map<string, NotificationRuleDto[]>();
  for (const r of rules.value) {
    const cat = events.value.find((e) => e.key === r.eventKey)?.category ?? 'Other';
    map.set(cat, [...(map.get(cat) ?? []), r]);
  }
  return [...map].map(([category, list]) => ({ category, rules: list }));
});

async function load() {
  try {
    [rules.value, events.value] = await Promise.all([commsApi.rules(), commsApi.events()]);
  } catch (e) {
    await toastError(e);
  }
}

const edit = (r: NotificationRuleDto) =>
  (form.value = { ...r, channels: [...r.channels], recipientTypes: [...r.recipientTypes] });

async function run(fn: () => Promise<unknown>) {
  saving.value = true;
  try {
    await fn();
    form.value = null;
    await toast('Trigger saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

const save = () =>
  run(() =>
    commsApi.saveRule(form.value!.eventKey, {
      channels: form.value!.channels,
      recipientTypes: form.value!.recipientTypes,
      isActive: form.value!.isActive,
    }),
  );
const reset = () => run(() => commsApi.resetRule(form.value!.eventKey));

onMounted(load);
</script>
