<template>
  <AppPage :title="t('website.announcements.title')" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="auth.can('website.create')"
        :aria-label="t('website.announcements.new')"
        @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-list>
      <ion-item v-for="a in items" :key="a.id" button :detail="false" @click="openEditor(a)">
        <ion-icon v-if="a.isPinned" slot="start" :icon="pinOutline" />
        <ion-label class="ion-text-wrap">
          <h2>{{ a.title }}</h2>
          <p v-if="a.body">{{ a.body }}</p>
          <p>{{ showWindow(a) }}</p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="a.isPublished ? t('website.status.published') : t('website.status.hidden')"
          :tone="a.isPublished ? 'success' : 'medium'"
        />
      </ion-item>
      <ion-item v-if="!items.length" lines="none"
        ><ion-label>{{ t('website.announcements.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{
            editingId ? t('website.announcements.edit') : t('website.announcements.new')
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
                v-model="form.title"
                :label="t('website.pages.fieldTitle')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item>
              <ion-textarea
                v-model="form.body"
                :label="t('website.announcements.details')"
                label-placement="stacked"
                :auto-grow="true"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.linkUrl"
                :label="t('website.editor.linkOptional')"
                label-placement="stacked"
                :placeholder="t('website.announcements.linkPlaceholder')"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.startsAt"
                type="date"
                :label="t('website.announcements.showFrom')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.endsAt"
                type="date"
                :label="t('website.announcements.showUntil')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item
              ><ion-toggle v-model="form.isPinned">{{
                t('website.announcements.pinned')
              }}</ion-toggle></ion-item
            >
            <ion-item
              ><ion-toggle v-model="form.isPublished">{{
                t('website.announcements.publishedOnWebsite')
              }}</ion-toggle></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">{{
            t('common.actions.save')
          }}</ion-button>
          <ion-button
            v-if="editingId && auth.can('website.delete')"
            expand="block"
            fill="clear"
            color="danger"
            @click="remove"
            >{{ t('common.actions.delete') }}</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add, pinOutline } from 'ionicons/icons';
import type { WebsiteAnnouncementDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { websiteApi } from './api';

interface Form {
  title: string;
  body: string;
  linkUrl: string;
  startsAt: string;
  endsAt: string;
  isPinned: boolean;
  isPublished: boolean;
}

const { t } = useI18n();
const auth = useAuthStore();
const items = ref<WebsiteAnnouncementDto[]>([]);
const form = ref<Form | null>(null);
const editingId = ref<number | null>(null);
const saving = ref(false);

const day = (d: string | null) => (d ? d.slice(0, 10) : '');
const showWindow = (a: WebsiteAnnouncementDto) =>
  a.startsAt || a.endsAt
    ? `${a.startsAt ? formatDate(day(a.startsAt)) : '…'} → ${a.endsAt ? formatDate(day(a.endsAt)) : '…'}`
    : t('website.announcements.always');

async function load() {
  try {
    items.value = (await websiteApi.announcements()).items;
  } catch (e) {
    await toastError(e);
  }
}

function openEditor(a?: WebsiteAnnouncementDto) {
  if (a && !auth.can('website.edit')) return;
  editingId.value = a?.id ?? null;
  form.value = {
    title: a?.title ?? '',
    body: a?.body ?? '',
    linkUrl: a?.linkUrl ?? '',
    startsAt: day(a?.startsAt ?? null),
    endsAt: day(a?.endsAt ?? null),
    isPinned: a?.isPinned ?? false,
    isPublished: a?.isPublished ?? true,
  };
}

async function save() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  try {
    await websiteApi.saveAnnouncement(editingId.value, {
      title: f.title,
      body: f.body || null,
      linkUrl: f.linkUrl || null,
      startsAt: f.startsAt || null,
      endsAt: f.endsAt ? `${f.endsAt}T23:59:59` : null,
      isPinned: f.isPinned,
      isPublished: f.isPublished,
    });
    form.value = null;
    await toast(t('website.announcements.saved'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!editingId.value) return;
  try {
    await websiteApi.removeAnnouncement(editingId.value);
    form.value = null;
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>
