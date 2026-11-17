<template>
  <AppPage :title="page ? page.title : 'Page'" back-href="/website" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="!page" @click="showPreview"
        ><ion-icon slot="icon-only" :icon="eyeOutline"
      /></ion-button>
      <ion-button :disabled="!page" @click="openVersions"
        ><ion-icon slot="icon-only" :icon="timeOutline"
      /></ion-button>
    </template>

    <template v-if="page">
      <ion-item lines="none">
        <ion-badge
          slot="start"
          :color="dirty ? 'tertiary' : page.status === 'published' ? 'success' : 'warning'"
        >
          {{
            dirty
              ? 'Unsaved'
              : page.status === 'published'
                ? 'Published'
                : page.status === 'changed'
                  ? 'Draft changes'
                  : 'Draft'
          }}
        </ion-badge>
        <ion-label class="ion-text-wrap">
          <p v-if="page.publishedVersion">
            Live version v{{ page.publishedVersion }} · {{ fmt(page.publishedAt) }}
          </p>
          <p v-else>Not published yet</p>
        </ion-label>
      </ion-item>
      <div class="actions">
        <ion-button v-if="canEdit" :disabled="saving || !dirty" @click="save()">Save draft</ion-button>
        <ion-button v-if="canPublish" color="success" :disabled="saving" @click="publish">Publish</ion-button>
        <ion-button
          v-if="canPublish && page.publishedVersion"
          fill="outline"
          color="medium"
          :disabled="saving"
          @click="unpublish"
          >Unpublish</ion-button
        >
        <ion-button v-if="canDelete && !page.isHome" fill="clear" color="danger" @click="remove"
          >Delete</ion-button
        >
      </div>

      <ion-accordion-group>
        <ion-accordion value="settings">
          <ion-item slot="header"><ion-label>Page settings & SEO</ion-label></ion-item>
          <ion-list slot="content">
            <ion-item><ion-input v-model="page.title" label="Title" label-placement="stacked" /></ion-item>
            <ion-item>
              <ion-input
                v-model="page.slug"
                label="URL slug"
                label-placement="stacked"
                :disabled="page.isHome"
              />
            </ion-item>
            <ion-item><ion-toggle v-model="page.showInNav">Show in site menu</ion-toggle></ion-item>
            <ion-item><ion-toggle v-model="page.isHome">Home page</ion-toggle></ion-item>
            <ion-item>
              <ion-input
                v-model="page.seo.title"
                label="SEO title"
                label-placement="stacked"
                :maxlength="70"
              />
            </ion-item>
            <ion-item>
              <ion-textarea
                v-model="page.seo.description"
                label="Meta description"
                label-placement="stacked"
                :maxlength="300"
                :auto-grow="true"
              />
            </ion-item>
            <ImageField v-model="page.seo.ogImageFileId" label="Social share (OG) image" />
          </ion-list>
        </ion-accordion>
      </ion-accordion-group>

      <ion-list>
        <ion-list-header>
          <ion-label>Blocks</ion-label>
          <ion-button v-if="canEdit" @click="addBlock"
            ><ion-icon slot="start" :icon="add" />Add block</ion-button
          >
        </ion-list-header>
        <ion-reorder-group :disabled="!canEdit" @ion-item-reorder="reorder($event)">
          <div v-for="(b, i) in page.blocks" :key="b.id">
            <ion-item button :detail="false" :class="{ hidden: b.hidden }" @click="toggle(b.id)">
              <ion-icon slot="start" :icon="open === b.id ? chevronDown : chevronForward" />
              <ion-label>
                <h2>{{ WEBSITE_BLOCK_LABELS[b.type] }}<span v-if="b.hidden"> (hidden)</span></h2>
                <p>{{ blockSummary(b) }}</p>
              </ion-label>
              <template v-if="canEdit">
                <ion-button slot="end" fill="clear" @click.stop="b.hidden = !b.hidden">
                  <ion-icon slot="icon-only" :icon="b.hidden ? eyeOffOutline : eyeOutline" />
                </ion-button>
                <ion-button slot="end" fill="clear" @click.stop="duplicate(i)">
                  <ion-icon slot="icon-only" :icon="copyOutline" />
                </ion-button>
                <ion-button slot="end" fill="clear" color="danger" @click.stop="page.blocks.splice(i, 1)">
                  <ion-icon slot="icon-only" :icon="trashOutline" />
                </ion-button>
              </template>
              <ion-reorder slot="end" />
            </ion-item>
            <div v-if="open === b.id" class="editor">
              <BlockEditor :block="b" :pages="pageRefs" :courses="courses" :branches="branches" />
            </div>
          </div>
        </ion-reorder-group>
        <ion-item v-if="!page.blocks.length" lines="none">
          <ion-label class="ion-text-center"><p>No blocks yet — add one to start building.</p></ion-label>
        </ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="previewHtml !== null" class="preview-modal" @did-dismiss="previewHtml = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Preview (draft)</ion-title>
          <ion-segment slot="end" :value="device" @ion-change="device = String($event.detail.value)">
            <ion-segment-button value="desktop"><ion-icon :icon="desktopOutline" /></ion-segment-button>
            <ion-segment-button value="mobile"><ion-icon :icon="phonePortraitOutline" /></ion-segment-button>
          </ion-segment>
          <ion-buttons slot="end"><ion-button @click="previewHtml = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <iframe
          v-if="previewHtml !== null"
          :srcdoc="previewHtml"
          sandbox=""
          title="Page preview"
          :class="['preview', device]"
        />
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="versions !== null" @did-dismiss="versions = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Published versions</ion-title>
          <ion-buttons slot="end"><ion-button @click="versions = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <ion-list>
          <ion-item v-for="v in versions" :key="v.id">
            <ion-label>
              <h2>
                v{{ v.version }} — {{ v.title }} <ion-badge v-if="v.isLive" color="success">live</ion-badge>
              </h2>
              <p>{{ fmt(v.publishedAt) }}{{ v.publishedByName ? ` · ${v.publishedByName}` : '' }}</p>
            </ion-label>
            <ion-button v-if="canEdit" slot="end" fill="outline" size="small" @click="restore(v)">
              Restore to draft
            </ion-button>
          </ion-item>
          <ion-item v-if="versions && !versions.length" lines="none"
            ><ion-label>Never published.</ion-label></ion-item
          >
        </ion-list>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
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
  IonListHeader,
  IonModal,
  IonReorder,
  IonReorderGroup,
  IonSegment,
  IonSegmentButton,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  actionSheetController,
  alertController,
  type ItemReorderEventDetail,
} from '@ionic/vue';
import {
  add,
  chevronDown,
  chevronForward,
  copyOutline,
  desktopOutline,
  eyeOffOutline,
  eyeOutline,
  phonePortraitOutline,
  timeOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  WEBSITE_BLOCK_LABELS,
  WEBSITE_BLOCK_TYPES,
  type WebsiteBlock,
  type WebsitePageDto,
  type WebsitePageSummaryDto,
  type WebsitePageVersionDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { websiteApi, type NamedRef } from './api';
import BlockEditor from './BlockEditor.vue';
import ImageField from './ImageField.vue';
import { blockSummary, cleanBlock, newBlock } from './blockDefaults';

type EditablePage = WebsitePageDto & { seo: NonNullable<WebsitePageDto['seo']> };

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const page = ref<EditablePage | null>(null);
const allPages = ref<WebsitePageSummaryDto[]>([]);
const courses = ref<NamedRef[]>([]);
const branches = ref<NamedRef[]>([]);
const open = ref<string | null>(null);
const dirty = ref(false);
const saving = ref(false);
const previewHtml = ref<string | null>(null);
const device = ref('desktop');
const versions = ref<WebsitePageVersionDto[] | null>(null);

const canEdit = computed(() => auth.can('website.edit'));
const canPublish = computed(() => auth.can('website.publish'));
const canDelete = computed(() => auth.can('website.delete'));
const pageRefs = computed(() => allPages.value.map((p) => ({ slug: p.slug, title: p.title })));

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '');

function setPage(p: WebsitePageDto) {
  page.value = { ...p, seo: { title: '', description: '', ogImageFileId: null, ...(p.seo ?? {}) } };
  // The watcher fires for this assignment; reset afterwards.
  queueMicrotask(() => (dirty.value = false));
}

watch(page, () => (dirty.value = true), { deep: true });

async function load() {
  try {
    const [p, list] = await Promise.all([websiteApi.page(id.value), websiteApi.pages()]);
    setPage(p);
    allPages.value = list;
  } catch (e) {
    await toastError(e);
  }
  // Pickers are best-effort: users without academics/branches access can still edit text blocks.
  const [c, b] = await Promise.all([
    api.get<{ items: NamedRef[] }>('/academics/courses', { pageSize: 100 }).catch(() => ({ items: [] })),
    api.get<NamedRef[]>('/branches').catch(() => []),
  ]);
  courses.value = c.items.map(({ id, name }) => ({ id, name }));
  branches.value = b.map(({ id, name }) => ({ id, name }));
}

function body() {
  const p = page.value!;
  return {
    title: p.title,
    slug: p.slug,
    showInNav: p.showInNav,
    isHome: p.isHome,
    seo: {
      title: p.seo.title || null,
      description: p.seo.description || null,
      ogImageFileId: p.seo.ogImageFileId || null,
    },
    blocks: p.blocks.map(cleanBlock),
  };
}

async function save(quiet = false) {
  if (!page.value) return false;
  saving.value = true;
  try {
    setPage(await websiteApi.updatePage(id.value, body()));
    if (!quiet) await toast('Draft saved');
    return true;
  } catch (e) {
    await toastError(e);
    return false;
  } finally {
    saving.value = false;
  }
}

async function showPreview() {
  if (dirty.value && canEdit.value && !(await save(true))) return;
  try {
    previewHtml.value = (await websiteApi.preview(id.value)).html;
  } catch (e) {
    await toastError(e);
  }
}

async function publish() {
  if (dirty.value && !(await save(true))) return;
  saving.value = true;
  try {
    setPage(await websiteApi.publish(id.value));
    await toast(`Published v${page.value!.publishedVersion}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function unpublish() {
  saving.value = true;
  try {
    setPage(await websiteApi.unpublish(id.value));
    await toast('Page taken offline', 'medium');
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const a = await alertController.create({
    header: `Delete “${page.value?.title}”?`,
    message: 'The page and its published versions will be removed from the website.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () =>
          websiteApi
            .removePage(id.value)
            .then(() => {
              dirty.value = false;
              return router.replace('/website');
            })
            .catch(toastError),
      },
    ],
  });
  await a.present();
}

async function openVersions() {
  try {
    versions.value = await websiteApi.versions(id.value);
  } catch (e) {
    await toastError(e);
  }
}

async function restore(v: WebsitePageVersionDto) {
  try {
    setPage(await websiteApi.restore(id.value, v.id));
    versions.value = null;
    await toast(`v${v.version} restored as draft — publish to make it live`);
  } catch (e) {
    await toastError(e);
  }
}

async function addBlock() {
  const sheet = await actionSheetController.create({
    header: 'Add block',
    buttons: [
      ...WEBSITE_BLOCK_TYPES.map((t) => ({
        text: WEBSITE_BLOCK_LABELS[t],
        handler: () => {
          const b = newBlock(t);
          page.value!.blocks.push(b);
          open.value = b.id;
        },
      })),
      { text: 'Cancel', role: 'cancel' },
    ],
  });
  await sheet.present();
}

function duplicate(i: number) {
  const copy = JSON.parse(JSON.stringify(page.value!.blocks[i])) as WebsiteBlock;
  copy.id = newBlock(copy.type).id;
  page.value!.blocks.splice(i + 1, 0, copy);
}

function toggle(blockId: string) {
  open.value = open.value === blockId ? null : blockId;
}

function reorder(ev: CustomEvent<ItemReorderEventDetail>) {
  page.value!.blocks = ev.detail.complete(page.value!.blocks);
}

onBeforeRouteLeave(async () => {
  if (!dirty.value || !canEdit.value) return true;
  const a = await alertController.create({
    header: 'Discard unsaved changes?',
    buttons: [
      { text: 'Stay', role: 'cancel' },
      { text: 'Discard', role: 'destructive' },
    ],
  });
  await a.present();
  const { role } = await a.onDidDismiss();
  return role === 'destructive';
});

onMounted(load);
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 8px 8px;
}
.editor {
  padding: 0 0 8px 24px;
  background: var(--ion-color-light);
}
.hidden ion-label {
  opacity: 0.5;
}
.preview {
  border: 0;
  width: 100%;
  height: 100%;
  display: block;
  margin: 0 auto;
  background: #fff;
}
.preview.mobile {
  width: 390px;
  max-width: 100%;
  border-left: 1px solid #ddd;
  border-right: 1px solid #ddd;
}
.preview-modal {
  --width: 100%;
  --height: 100%;
}
</style>
