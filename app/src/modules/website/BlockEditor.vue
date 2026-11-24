<template>
  <ion-list>
    <ion-item v-if="block.type !== 'image'">
      <ion-input
        v-model="s.heading"
        :label="t('website.editor.heading')"
        label-placement="stacked"
        :maxlength="150"
      />
    </ion-item>

    <template v-if="block.type === 'hero'">
      <ion-item>
        <ion-input
          v-model="s.subheading"
          :label="t('website.editor.subheading')"
          label-placement="stacked"
          :maxlength="300"
        />
      </ion-item>
      <ImageField v-model="s.imageFileId" :label="t('website.editor.backgroundImage')" />
      <ion-item
        ><ion-input v-model="s.ctaLabel" :label="t('website.editor.buttonLabel')" label-placement="stacked"
      /></ion-item>
      <LinkField v-model="s.ctaHref" :pages="pages" :courses="courses" />
    </template>

    <template v-else-if="block.type === 'text'">
      <ion-item>
        <ion-textarea
          v-model="s.body"
          :label="t('website.editor.text')"
          label-placement="stacked"
          :auto-grow="true"
          :rows="6"
          :helper-text="t('website.editor.markdownHelp')"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'image'">
      <ImageField v-model="s.fileId" :label="t('website.editor.image')" :clearable="false" />
      <ion-item
        ><ion-input v-model="s.alt" :label="t('website.editor.altText')" label-placement="stacked"
      /></ion-item>
      <ion-item
        ><ion-input v-model="s.caption" :label="t('website.editor.caption')" label-placement="stacked"
      /></ion-item>
      <LinkField
        v-model="s.href"
        :pages="pages"
        :courses="courses"
        :label="t('website.editor.linkOptional')"
      />
    </template>

    <template v-else-if="block.type === 'gallery'">
      <div v-for="(img, i) in s.images" :key="i" class="sub">
        <ImageField
          v-model="img.fileId"
          :label="t('website.editor.imageN', { n: i + 1 })"
          :clearable="false"
        />
        <ion-item>
          <ion-input v-model="img.caption" :label="t('website.editor.caption')" label-placement="stacked" />
          <ion-button
            slot="end"
            fill="clear"
            color="danger"
            :aria-label="t('website.editor.removeImage')"
            @click="s.images!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
      </div>
      <ion-button fill="clear" size="small" @click="addGalleryImage">{{
        t('website.editor.addImage')
      }}</ion-button>
      <input ref="galleryInput" type="file" accept="image/*" multiple hidden @change="uploadGallery" />
    </template>

    <template v-else-if="block.type === 'courses'">
      <ion-item>
        <ion-select
          v-model="s.courseIds"
          :label="t('website.editor.courses')"
          label-placement="stacked"
          :multiple="true"
          :placeholder="t('website.editor.allActiveCourses')"
        >
          <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item
        ><ion-toggle v-model="s.showDescription">{{
          t('website.editor.showDescriptions')
        }}</ion-toggle></ion-item
      >
      <ion-item>
        <ion-toggle v-model="s.showBuyButton">{{ t('website.editor.showBuyButton') }}</ion-toggle>
      </ion-item>
    </template>

    <template v-else-if="block.type === 'batches'">
      <RefSelect
        v-model="s.courseId"
        :label="t('website.editor.course')"
        :empty-label="t('website.editor.anyCourse')"
        :options="courses"
      />
      <RefSelect
        v-model="s.branchId"
        :label="t('website.editor.branch')"
        :empty-label="t('website.editor.defaultBranch')"
        :options="branches"
      />
      <ion-item
        ><ion-toggle v-model="s.upcomingOnly">{{ t('website.editor.upcomingOnly') }}</ion-toggle></ion-item
      >
      <ion-item>
        <ion-input
          v-model.number="s.limit"
          type="number"
          min="1"
          max="50"
          :label="t('website.editor.maxBatches')"
          label-placement="stacked"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'faculty'">
      <div v-for="(m, i) in s.members" :key="i" class="sub">
        <ion-item>
          <ion-input v-model="m.name" :label="t('common.labels.name')" label-placement="stacked" />
          <ion-button
            slot="end"
            fill="clear"
            color="danger"
            :aria-label="t('website.editor.removeMember')"
            @click="s.members!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item
          ><ion-input v-model="m.subject" :label="t('website.editor.subject')" label-placement="stacked"
        /></ion-item>
        <ion-item
          ><ion-textarea
            v-model="m.bio"
            :label="t('website.editor.bio')"
            label-placement="stacked"
            :auto-grow="true"
        /></ion-item>
        <ImageField v-model="m.photoFileId" :label="t('website.editor.photo')" />
      </div>
      <ion-button fill="clear" size="small" @click="s.members!.push({ name: '', subject: '', bio: '' })">{{
        t('website.editor.addFaculty')
      }}</ion-button>
    </template>

    <template v-else-if="block.type === 'testimonials'">
      <div v-for="(item, i) in s.items" :key="i" class="sub">
        <ion-item>
          <ion-input v-model="item.name" :label="t('common.labels.name')" label-placement="stacked" />
          <ion-button
            slot="end"
            fill="clear"
            color="danger"
            :aria-label="t('website.editor.removeItem')"
            @click="s.items!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item
          ><ion-input v-model="item.role" :label="t('website.editor.role')" label-placement="stacked"
        /></ion-item>
        <ion-item
          ><ion-textarea
            v-model="item.quote"
            :label="t('website.editor.quote')"
            label-placement="stacked"
            :auto-grow="true"
        /></ion-item>
        <ImageField v-model="item.photoFileId" :label="t('website.editor.photo')" />
      </div>
      <ion-button fill="clear" size="small" @click="s.items!.push({ name: '', role: '', quote: '' })">{{
        t('website.editor.addTestimonial')
      }}</ion-button>
    </template>

    <template v-else-if="block.type === 'announcements'">
      <ion-item>
        <ion-input
          v-model.number="s.limit"
          type="number"
          min="1"
          max="20"
          :label="t('website.editor.maxItems')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item lines="none"
        ><ion-note>{{ t('website.editor.announcementsNote') }}</ion-note></ion-item
      >
    </template>

    <template v-else-if="block.type === 'enquiry_form' || block.type === 'demo_form'">
      <ion-item
        ><ion-textarea
          v-model="s.intro"
          :label="t('website.editor.intro')"
          label-placement="stacked"
          :auto-grow="true"
      /></ion-item>
      <RefSelect
        v-if="block.type === 'demo_form'"
        v-model="s.courseId"
        :label="t('website.editor.course')"
        :empty-label="t('website.editor.anyCourse')"
        :options="courses"
      />
      <RefSelect
        v-model="s.branchId"
        :label="t('website.editor.branch')"
        :empty-label="t('website.editor.defaultBranch')"
        :options="branches"
      />
      <template v-if="block.type === 'demo_form'">
        <ion-list-header
          ><ion-label>{{ t('website.editor.demoSlots') }}</ion-label></ion-list-header
        >
        <ion-item v-for="(slot, i) in s.slots" :key="i">
          <ion-input
            v-model="slot.label"
            :label="t('website.editor.slot')"
            label-placement="stacked"
            :placeholder="t('website.editor.slotPlaceholder')"
          />
          <ion-input
            v-model="slot.startsAt"
            type="datetime-local"
            :label="t('website.editor.startsAt')"
            label-placement="stacked"
          />
          <ion-button
            slot="end"
            fill="clear"
            color="danger"
            :aria-label="t('website.editor.removeSlot')"
            @click="s.slots!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-button fill="clear" size="small" @click="s.slots!.push({ label: '', startsAt: null })">{{
          t('website.editor.addSlot')
        }}</ion-button>
      </template>
      <ion-item
        ><ion-input
          v-model="s.submitLabel"
          :label="t('website.editor.submitLabel')"
          label-placement="stacked"
      /></ion-item>
      <ion-item>
        <ion-input
          v-model="s.successMessage"
          :label="t('website.editor.successMessage')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item lines="none">
        <ion-note>{{ t('website.editor.submissionsNote') }}</ion-note>
      </ion-item>
    </template>

    <template v-else-if="block.type === 'contact'">
      <ion-item
        ><ion-textarea
          v-model="s.address"
          :label="t('website.editor.address')"
          label-placement="stacked"
          :auto-grow="true"
      /></ion-item>
      <ion-item
        ><ion-input v-model="s.phone" :label="t('website.editor.phone')" label-placement="stacked"
      /></ion-item>
      <ion-item
        ><ion-input
          v-model="s.email"
          type="email"
          :label="t('website.editor.email')"
          label-placement="stacked"
      /></ion-item>
      <ion-item>
        <ion-input
          v-model="s.mapQuery"
          :label="t('website.editor.mapLocation')"
          label-placement="stacked"
          :helper-text="t('website.editor.mapHelp')"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'cta'">
      <ion-item
        ><ion-textarea
          v-model="s.text"
          :label="t('website.editor.text')"
          label-placement="stacked"
          :auto-grow="true"
      /></ion-item>
      <ion-item
        ><ion-input
          v-model="s.buttonLabel"
          :label="t('website.editor.buttonLabel')"
          label-placement="stacked"
      /></ion-item>
      <LinkField v-model="s.buttonHref" :pages="pages" :courses="courses" />
    </template>
  </ion-list>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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
import type {
  AnnouncementsSettings,
  BatchesSettings,
  ContactSettings,
  CoursesSettings,
  CtaSettings,
  DemoFormSettings,
  EnquiryFormSettings,
  FacultySettings,
  GallerySettings,
  HeroSettings,
  ImageSettings,
  TestimonialsSettings,
  TextSettings,
  WebsiteBlock,
} from '@erp/shared';
import { toastError } from '@/core/toast';
import { websiteApi } from './api';
import type { NamedRef } from './api';
import ImageField from './ImageField.vue';
import RefSelect from './RefSelect.vue';
import LinkField from './LinkField.vue';

const { t } = useI18n();
const props = defineProps<{
  block: WebsiteBlock;
  pages: { slug: string; title: string }[];
  courses: NamedRef[];
  branches: NamedRef[];
}>();

/** Union of every block's settings, so the template can bind fields without per-type narrowing. */
type LooseSettings = Partial<
  HeroSettings &
    TextSettings &
    ImageSettings &
    GallerySettings &
    CoursesSettings &
    BatchesSettings &
    FacultySettings &
    TestimonialsSettings &
    AnnouncementsSettings &
    EnquiryFormSettings &
    DemoFormSettings &
    ContactSettings &
    CtaSettings
>;
const s = computed(() => props.block.settings as unknown as LooseSettings);

const galleryInput = ref<HTMLInputElement | null>(null);
const addGalleryImage = () => galleryInput.value?.click();
async function uploadGallery(ev: Event) {
  const files = Array.from((ev.target as HTMLInputElement).files ?? []);
  try {
    for (const f of files) {
      const up = await websiteApi.upload(f);
      s.value.images!.push({ fileId: up.id, caption: '' });
    }
  } catch (e) {
    await toastError(e);
  } finally {
    if (galleryInput.value) galleryInput.value.value = '';
  }
}
</script>

<style scoped>
.sub {
  border-left: 3px solid var(--ion-color-light-shade);
  margin: 8px 0 8px 8px;
}
</style>
