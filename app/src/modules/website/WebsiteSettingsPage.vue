<template>
  <AppPage :title="t('website.settings.title')" :on-refresh="load">
    <ion-list v-if="form">
      <ion-list-header
        ><ion-label>{{ t('website.settings.address') }}</ion-label></ion-list-header
      >
      <ion-item lines="none">
        <ion-label class="ion-text-wrap">
          <p>
            {{ t('website.settings.publicUrl') }}
            <a :href="site?.publicUrl" target="_blank" rel="noopener">{{ site?.publicUrl }}</a>
          </p>
        </ion-label>
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.subdomain"
          :label="t('website.settings.subdomain')"
          label-placement="stacked"
          :helper-text="t('website.settings.subdomainHelp', { domain: '<platform domain>' })"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.customDomain"
          :label="t('website.settings.customDomain')"
          label-placement="stacked"
          :helper-text="t('website.settings.customDomainHelp')"
        />
      </ion-item>
      <ion-item v-if="site?.domainVerification" lines="none">
        <ion-label class="ion-text-wrap">
          <p v-if="site.domainVerification.verifiedAt">
            <ion-note color="success">{{ t('website.settings.verified') }}</ion-note>
            {{ t('website.settings.servedOn', { domain: site.customDomain }) }}
          </p>
          <template v-else>
            <p>
              <ion-note color="warning">{{ t('website.settings.notVerified') }}</ion-note>
              {{ t('website.settings.notServed', { domain: site.customDomain }) }}
            </p>
            <p>
              {{ t('website.settings.recordName') }} <code>{{ site.domainVerification.recordName }}</code>
            </p>
            <p>
              {{ t('website.settings.recordValue') }} <code>{{ site.domainVerification.recordValue }}</code>
            </p>
          </template>
        </ion-label>
        <ion-button
          v-if="!site.domainVerification.verifiedAt"
          slot="end"
          fill="outline"
          :disabled="verifying"
          @click="verifyDomain"
        >
          {{ t('website.settings.verifyDomain') }}
        </ion-button>
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.appUrl"
          :label="t('website.settings.appUrl')"
          label-placement="stacked"
          :helper-text="t('website.settings.appUrlHelp', { path: '<app URL>/register/<institute>' })"
        />
      </ion-item>
      <ion-item>
        <ion-select
          v-model="form.defaultBranchId"
          :label="t('website.settings.enquiryBranch')"
          label-placement="stacked"
          interface="popover"
        >
          <ion-select-option :value="null">{{ t('website.settings.mainBranch') }}</ion-select-option>
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>

      <ion-list-header
        ><ion-label>{{ t('website.settings.branding') }}</ion-label></ion-list-header
      >
      <ion-item lines="none">
        <ion-note>{{ t('website.settings.brandingNote') }}</ion-note>
      </ion-item>
      <ion-item>
        <ion-input
          v-model="form.theme.primaryColor"
          :label="t('website.settings.primaryColour')"
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
          :label="t('website.settings.secondaryColour')"
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
        <ion-select
          v-model="form.theme.font"
          :label="t('website.settings.font')"
          label-placement="stacked"
          interface="popover"
        >
          <ion-select-option value="system">{{ t('website.settings.fonts.system') }}</ion-select-option>
          <ion-select-option value="serif">{{ t('website.settings.fonts.serif') }}</ion-select-option>
          <ion-select-option value="rounded">{{ t('website.settings.fonts.rounded') }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.theme.footerText"
          :label="t('website.settings.footerText')"
          label-placement="stacked"
          :auto-grow="true"
        />
      </ion-item>
      <ion-item v-for="(l, i) in form.theme.socialLinks" :key="i">
        <ion-input
          v-model="l.label"
          :label="t('website.settings.label')"
          label-placement="stacked"
          placeholder="YouTube"
        />
        <ion-input
          v-model="l.url"
          :label="t('website.settings.url')"
          label-placement="stacked"
          :placeholder="t('website.settings.urlPlaceholder')"
        />
        <ion-button
          slot="end"
          fill="clear"
          color="danger"
          :aria-label="t('website.settings.removeSocial')"
          @click="form.theme.socialLinks!.splice(i, 1)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-button fill="clear" size="small" @click="form.theme.socialLinks!.push({ label: '', url: '' })">{{
        t('website.settings.addSocial')
      }}</ion-button>

      <ion-list-header
        ><ion-label>{{ t('website.settings.seo') }}</ion-label></ion-list-header
      >
      <ion-item>
        <ion-input
          v-model="form.seo.title"
          :label="t('website.settings.defaultTitle')"
          label-placement="stacked"
          :maxlength="70"
        />
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.seo.description"
          :label="t('website.settings.defaultDescription')"
          label-placement="stacked"
          :maxlength="300"
          :auto-grow="true"
        />
      </ion-item>
      <ImageField v-model="form.seo.ogImageFileId" :label="t('website.settings.defaultOgImage')" />
      <ion-item>
        <ion-toggle v-model="form.seo.indexable">{{ t('website.settings.indexable') }}</ion-toggle>
      </ion-item>
      <ion-item lines="none">
        <ion-label class="ion-text-wrap">
          <p>
            <a :href="site?.sitemapUrl" target="_blank" rel="noopener">sitemap.xml</a> ·
            <a :href="site?.robotsUrl" target="_blank" rel="noopener">robots.txt</a>
          </p>
        </ion-label>
      </ion-item>
      <ion-button expand="block" :disabled="saving" @click="save">{{
        t('website.settings.save')
      }}</ion-button>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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

const { t } = useI18n();
const site = ref<WebsiteSiteDto | null>(null);
const form = ref<Form | null>(null);
const branches = ref<NamedRef[]>([]);
const saving = ref(false);
const verifying = ref(false);

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
    await toast(t('website.settings.saved'));
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function verifyDomain() {
  verifying.value = true;
  try {
    site.value = await websiteApi.verifyDomain();
    await toast(t('website.settings.domainVerified'));
  } catch (e) {
    await toastError(e);
  } finally {
    verifying.value = false;
  }
}

onMounted(load);
</script>
