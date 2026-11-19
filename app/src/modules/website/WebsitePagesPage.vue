<template>
  <AppPage title="Website builder" :on-refresh="load">
    <template #actions>
      <ion-button v-if="site" :href="site.publicUrl" target="_blank" rel="noopener" aria-label="Open website">
        <ion-icon slot="icon-only" :icon="openOutline" />
      </ion-button>
    </template>
    <ion-card v-if="site">
      <ion-card-content>
        <p>
          Live site: <a :href="site.publicUrl" target="_blank" rel="noopener">{{ site.publicUrl }}</a>
        </p>
        <p class="muted">Sitemap: {{ site.sitemapUrl }} · Robots: {{ site.robotsUrl }}</p>
      </ion-card-content>
    </ion-card>

    <ion-list>
      <ion-list-header>
        <ion-label>Pages</ion-label>
        <ion-button v-if="auth.can('website.create')" aria-label="New page" @click="openNew"
          ><ion-icon slot="icon-only" :icon="add"
        /></ion-button>
      </ion-list-header>
      <ion-item v-for="p in pages" :key="p.id" button :router-link="`/website/pages/${p.id}`">
        <ion-icon slot="start" :icon="p.isHome ? homeOutline : documentTextOutline" />
        <ion-label>
          <h2>{{ p.title }}</h2>
          <p>/{{ p.isHome ? '' : `p/${p.slug}` }}{{ p.showInNav ? '' : ' · hidden from menu' }}</p>
        </ion-label>
        <ion-badge slot="end" :color="statusColor[p.status]">{{ statusLabel[p.status] }}</ion-badge>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>New page</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="create">
          <ion-list>
            <ion-item>
              <ion-input
                v-model="form.title"
                label="Title"
                label-placement="stacked"
                required
                @ion-input="autoSlug"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.slug"
                label="URL slug"
                label-placement="stacked"
                helper-text="lowercase letters, digits and dashes"
                required
              />
            </ion-item>
            <ion-item><ion-toggle v-model="form.showInNav">Show in site menu</ion-toggle></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving">Create</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import { add, documentTextOutline, homeOutline, openOutline } from 'ionicons/icons';
import type { WebsitePageStatus, WebsitePageSummaryDto, WebsiteSiteDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { useAuthStore } from '@/stores/auth';
import { toastError } from '@/core/toast';
import { websiteApi } from './api';

const auth = useAuthStore();
const router = useRouter();
const pages = ref<WebsitePageSummaryDto[]>([]);
const site = ref<WebsiteSiteDto | null>(null);
const form = ref<{ title: string; slug: string; showInNav: boolean } | null>(null);
const saving = ref(false);

const statusLabel: Record<WebsitePageStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  changed: 'Unpublished changes',
};
const statusColor: Record<WebsitePageStatus, string> = {
  draft: 'medium',
  published: 'success',
  changed: 'warning',
};

async function load() {
  try {
    const [p, s] = await Promise.all([websiteApi.pages(), websiteApi.site()]);
    pages.value = p;
    site.value = s;
  } catch (e) {
    await toastError(e);
  }
}

function openNew() {
  form.value = { title: '', slug: '', showInNav: true };
}

function autoSlug() {
  if (!form.value) return;
  form.value.slug = form.value.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function create() {
  if (!form.value) return;
  saving.value = true;
  try {
    const page = await websiteApi.createPage({ ...form.value, blocks: [] });
    form.value = null;
    await router.push(`/website/pages/${page.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
  font-size: 0.85em;
  word-break: break-all;
}
</style>
