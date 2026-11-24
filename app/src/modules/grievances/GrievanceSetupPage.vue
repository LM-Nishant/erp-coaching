<template>
  <AppPage :title="t('grievances.setup.title')" :on-refresh="load">
    <ion-list v-if="settings">
      <ion-list-header
        ><ion-label>{{ t('grievances.setup.settings') }}</ion-label></ion-list-header
      >
      <ion-item>
        <ion-input
          v-model="settings.ticketPrefix"
          :label="t('grievances.setup.ticketPrefix')"
          label-placement="stacked"
          :helper-text="t('grievances.setup.ticketPrefixHelp')"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="settings.defaultSlaHours"
          type="number"
          :label="t('grievances.setup.defaultSla')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="settings.escalationUserId"
          :label="t('grievances.setup.escalateTo')"
          label-placement="stacked"
          interface="popover"
        >
          <ion-select-option :value="null">{{ t('grievances.setup.keepAssignee') }}</ion-select-option>
          <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{ a.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-button expand="block" :disabled="saving" @click="saveSettings">{{
        t('grievances.setup.saveSettings')
      }}</ion-button>
    </ion-list>

    <ion-list>
      <ion-list-header>
        <ion-label>{{ t('grievances.setup.categories') }}</ion-label>
        <ion-button :aria-label="t('grievances.setup.newCategory')" @click="openEditor()"
          ><ion-icon slot="icon-only" :icon="add"
        /></ion-button>
      </ion-list-header>
      <ion-item v-for="c in categories" :key="c.id">
        <ion-label>
          <h2>
            {{ c.name }}
            <StatusChip v-if="!c.isActive" :label="t('common.status.inactive')" />
          </h2>
          <p>
            {{ t('grievances.setup.slaLine', { n: formatNumber(c.slaHours) }) }} ·
            {{ c.defaultAssigneeName ?? t('grievances.setup.noDefaultAssignee') }}
          </p>
          <p v-if="c.description">{{ c.description }}</p>
        </ion-label>
        <ion-button
          slot="end"
          fill="clear"
          :aria-label="t('grievances.setup.editAria', { name: c.name })"
          @click="openEditor(c)"
          ><ion-icon slot="icon-only" :icon="createOutline"
        /></ion-button>
        <ion-button
          slot="end"
          fill="clear"
          color="danger"
          :aria-label="t('grievances.setup.deleteAria', { name: c.name })"
          @click="remove(c)"
          ><ion-icon slot="icon-only" :icon="trashOutline"
        /></ion-button>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{
            editingId ? t('grievances.setup.editCategory') : t('grievances.setup.newCategory')
          }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input
                v-model="form.name"
                :label="t('common.labels.name')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item>
              <ion-textarea
                v-model="form.description"
                :label="t('grievances.setup.description')"
                label-placement="stacked"
                :auto-grow="true"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="form.slaHours"
                type="number"
                :label="t('grievances.setup.slaHours')"
                label-placement="stacked"
                min="1"
              />
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.defaultAssigneeUserId"
                :label="t('grievances.setup.defaultAssignee')"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">{{ t('common.labels.none') }}</ion-select-option>
                <ion-select-option v-for="a in assignees" :key="a.id" :value="a.id">{{
                  a.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-toggle v-model="form.isActive">{{ t('common.status.active') }}</ion-toggle></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">{{
            t('common.actions.save')
          }}</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
import { useI18n } from 'vue-i18n';
import type {
  GrievanceCategoryDto,
  GrievanceCategoryInput,
  GrievanceSettingsDto,
  GrievanceUserRef,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { grievancesApi } from './api';

const { t } = useI18n();
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
    await toast(t('grievances.setup.settingsSaved'));
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
    await toast(t('grievances.setup.categorySaved'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(c: GrievanceCategoryDto) {
  const alert = await alertController.create({
    header: t('grievances.setup.deleteTitle', { name: c.name }),
    message: t('grievances.setup.deleteMessage'),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('common.actions.delete'),
        role: 'destructive',
        handler: () => grievancesApi.removeCategory(c.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
