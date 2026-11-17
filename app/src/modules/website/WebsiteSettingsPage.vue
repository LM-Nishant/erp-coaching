<template>
  <AppPage title="Website settings & SEO" :on-refresh="load">
    <ion-list v-if="form">
      <ion-list-header><ion-label>Address</ion-label></ion-list-header>
      <ion-item lines="none">
        <ion-label class="ion-text-wrap">
          <p>
            Public URL: <a :href="site?.publicUrl" target="_blank" rel="noopener">{{ site?.publicUrl }}</a>
          </p>
        </ion-label>
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.subdomain"
          label="Subdomain"
          label-placement="stacked"
          helper-text="e.g. “apex” for apex.<platform domain>"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.customDomain"
          label="Custom domain"
          label-placement="stacked"
          helper-text="e.g. www.apexacademy.in — point its DNS (CNAME) at the platform; the platform team maps it."
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.appUrl"
          label="App URL for online admission"
          label-placement="stacked"
          helper-text="Self-registration links go to <app URL>/register/<institute>. Leave blank for the default."
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="form.defaultBranchId"
          label="Branch for website enquiries"
          label-placement="stacked"
          interface="popover"
        >
          <ion-select-option :value="null">Main branch</ion-select-option>
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>

      <ion-list-header><ion-label>Branding</ion-label></ion-list-header>
      <ion-item lines="none">
        <ion-note
          >Logo and colours default to your institute branding; override them for the website below.</ion-note
        >
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.theme.primaryColor"
          label="Primary colour"
          label-placement="stacked"
          placeholder="#1e40af"
        />
        <input
          slot="end"
          type="color"
          :value="form.theme.primaryColor || '#1e40af'"
          @input="pickColour('primaryColor', $event)"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.theme.secondaryColor"
          label="Secondary colour"
          label-placement="stacked"
          placeholder="#f59e0b"
        />
        <input
          slot="end"
          type="color"
          :value="form.theme.secondaryColor || '#f59e0b'"
          @input="pickColour('secondaryColor', $event)"
        />
      </ion-item>
      <ion-item>
        <ion-select v-model="form.theme.font" label="Font" label-placement="stacked" interface="popover">
          <ion-select-option value="system">System sans-serif</ion-select-option>
          <ion-select-option value="serif">Serif</ion-select-option>
          <ion-select-option value="rounded">Rounded</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.theme.footerText"
          label="Footer text"
          label-placement="stacked"
          :auto-grow="true"
        />
      </ion-item>
      <ion-item v-for="(l, i) in form.theme.socialLinks" :key="i">
        <ion-input v-model="l.label" label="Label" label-placement="stacked" placeholder="YouTube" />
        <ion-input v-model="l.url" label="URL" label-placement="stacked" placeholder="Full web address" />
        <ion-button slot="end" fill="clear" color="danger" @click="form.theme.socialLinks!.splice(i, 1)">
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-button fill="clear" size="small" @click="form.theme.socialLinks!.push({ label: '', url: '' })"
        >+ Add social link</ion-button
      >

      <ion-list-header><ion-label>SEO</ion-label></ion-list-header>
      <ion-item>
        <ion-input v-model="form.seo.title" label="Default title" label-placement="stacked" :maxlength="70" />
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.seo.description"
          label="Default meta description"
          label-placement="stacked"
          :maxlength="300"
          :auto-grow="true"
        />
      </ion-item>
      <ImageField v-model="form.seo.ogImageFileId" label="Default social share (OG) image" />
      <ion-item>
        <ion-toggle v-model="form.seo.indexable">Allow search engines to index the site</ion-toggle>
      </ion-item>
      <ion-item lines="none">
        <ion-label class="ion-text-wrap">
          <p>
            <a :href="site?.sitemapUrl" target="_blank" rel="noopener">sitemap.xml</a> ·
            <a :href="site?.robotsUrl" target="_blank" rel="noopener">robots.txt</a>
          </p>
        </ion-label>
      </ion-item>
      <ion-button expand="block" :disabled="saving" @click="save">Save settings</ion-button>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToggle,
} from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import type { WebsiteSeo, WebsiteSiteDto, WebsiteTheme } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { websiteApi, type NamedRef } from './api';
import ImageField from './ImageField.vue';

interface Form {
  subdomain: string;
  customDomain: string;
  appUrl: string;
  defaultBranchId: number | null;
  theme: WebsiteTheme;
  seo: WebsiteSeo & { indexable: boolean };
}

const site = ref<WebsiteSiteDto | null>(null);
const form = ref<Form | null>(null);
const branches = ref<NamedRef[]>([]);
const saving = ref(false);

function toForm(s: WebsiteSiteDto): Form {
  return {
    subdomain: s.subdomain ?? '',
    customDomain: s.customDomain ?? '',
    appUrl: s.appUrl ?? '',
    defaultBranchId: s.defaultBranchId,
    theme: { font: 'system', socialLinks: [], ...s.theme },
    seo: { title: '', description: '', ogImageFileId: null, ...s.seo },
  };
}

async function load() {
  try {
    site.value = await websiteApi.site();
    form.value = toForm(site.value);
  } catch (e) {
    await toastError(e);
  }
  branches.value = await api.get<NamedRef[]>('/branches').catch(() => []);
}

function pickColour(key: 'primaryColor' | 'secondaryColor', ev: Event) {
  if (form.value) form.value.theme[key] = (ev.target as HTMLInputElement).value;
}

const blank = (v: string | null | undefined) => (v ? v : null);

async function save() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  try {
    site.value = await websiteApi.saveSite({
      subdomain: blank(f.subdomain),
      customDomain: blank(f.customDomain),
      appUrl: blank(f.appUrl),
      defaultBranchId: f.defaultBranchId,
      theme: {
        ...f.theme,
        primaryColor: blank(f.theme.primaryColor),
        secondaryColor: blank(f.theme.secondaryColor),
        footerText: blank(f.theme.footerText),
        socialLinks: (f.theme.socialLinks ?? []).filter((l) => l.label && l.url),
      },
      seo: {
        title: blank(f.seo.title),
        description: blank(f.seo.description),
        ogImageFileId: f.seo.ogImageFileId || null,
        indexable: f.seo.indexable,
      },
    });
    form.value = toForm(site.value);
    await toast('Website settings saved');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
