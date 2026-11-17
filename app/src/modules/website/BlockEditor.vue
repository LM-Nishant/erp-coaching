<template>
  <ion-list>
    <ion-item v-if="block.type !== 'image'">
      <ion-input v-model="s.heading" label="Heading" label-placement="stacked" :maxlength="150" />
    </ion-item>

    <template v-if="block.type === 'hero'">
      <ion-item>
        <ion-input v-model="s.subheading" label="Sub-heading" label-placement="stacked" :maxlength="300" />
      </ion-item>
      <ImageField v-model="s.imageFileId" label="Background image" />
      <ion-item><ion-input v-model="s.ctaLabel" label="Button label" label-placement="stacked" /></ion-item>
      <LinkField v-model="s.ctaHref" :pages="pages" :courses="courses" />
    </template>

    <template v-else-if="block.type === 'text'">
      <ion-item>
        <ion-textarea
          v-model="s.body"
          label="Text"
          label-placement="stacked"
          :auto-grow="true"
          :rows="6"
          helper-text="Markdown: ## heading, **bold**, *italic*, - list, [link](https://…)"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'image'">
      <ImageField v-model="s.fileId" label="Image" :clearable="false" />
      <ion-item><ion-input v-model="s.alt" label="Alt text" label-placement="stacked" /></ion-item>
      <ion-item><ion-input v-model="s.caption" label="Caption" label-placement="stacked" /></ion-item>
      <LinkField v-model="s.href" :pages="pages" :courses="courses" label="Link (optional)" />
    </template>

    <template v-else-if="block.type === 'gallery'">
      <div v-for="(img, i) in s.images" :key="i" class="sub">
        <ImageField v-model="img.fileId" :label="`Image ${i + 1}`" :clearable="false" />
        <ion-item>
          <ion-input v-model="img.caption" label="Caption" label-placement="stacked" />
          <ion-button slot="end" fill="clear" color="danger" @click="s.images!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
      </div>
      <ion-button fill="clear" size="small" @click="addGalleryImage">+ Add image</ion-button>
      <input ref="galleryInput" type="file" accept="image/*" multiple hidden @change="uploadGallery" />
    </template>

    <template v-else-if="block.type === 'courses'">
      <ion-item>
        <ion-select
          v-model="s.courseIds"
          label="Courses"
          label-placement="stacked"
          :multiple="true"
          placeholder="All active courses"
        >
          <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item><ion-toggle v-model="s.showDescription">Show descriptions</ion-toggle></ion-item>
      <ion-item
        ><ion-toggle v-model="s.showBuyButton">Show “Buy online” button (checkout)</ion-toggle></ion-item
      >
    </template>

    <template v-else-if="block.type === 'batches'">
      <RefSelect v-model="s.courseId" label="Course" empty-label="Any course" :options="courses" />
      <RefSelect v-model="s.branchId" label="Branch" empty-label="Default branch" :options="branches" />
      <ion-item><ion-toggle v-model="s.upcomingOnly">Only upcoming / running batches</ion-toggle></ion-item>
      <ion-item>
        <ion-input
          v-model.number="s.limit"
          type="number"
          min="1"
          max="50"
          label="Max batches"
          label-placement="stacked"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'faculty'">
      <div v-for="(m, i) in s.members" :key="i" class="sub">
        <ion-item>
          <ion-input v-model="m.name" label="Name" label-placement="stacked" />
          <ion-button slot="end" fill="clear" color="danger" @click="s.members!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item><ion-input v-model="m.subject" label="Subject" label-placement="stacked" /></ion-item>
        <ion-item
          ><ion-textarea v-model="m.bio" label="Bio" label-placement="stacked" :auto-grow="true"
        /></ion-item>
        <ImageField v-model="m.photoFileId" label="Photo" />
      </div>
      <ion-button fill="clear" size="small" @click="s.members!.push({ name: '', subject: '', bio: '' })"
        >+ Add faculty member</ion-button
      >
    </template>

    <template v-else-if="block.type === 'testimonials'">
      <div v-for="(t, i) in s.items" :key="i" class="sub">
        <ion-item>
          <ion-input v-model="t.name" label="Name" label-placement="stacked" />
          <ion-button slot="end" fill="clear" color="danger" @click="s.items!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item
          ><ion-input v-model="t.role" label="Role (e.g. JEE 2025, AIR 120)" label-placement="stacked"
        /></ion-item>
        <ion-item
          ><ion-textarea v-model="t.quote" label="Quote" label-placement="stacked" :auto-grow="true"
        /></ion-item>
        <ImageField v-model="t.photoFileId" label="Photo" />
      </div>
      <ion-button fill="clear" size="small" @click="s.items!.push({ name: '', role: '', quote: '' })"
        >+ Add testimonial</ion-button
      >
    </template>

    <template v-else-if="block.type === 'announcements'">
      <ion-item>
        <ion-input
          v-model.number="s.limit"
          type="number"
          min="1"
          max="20"
          label="Max items"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item lines="none"><ion-note>Manage items under Website announcements.</ion-note></ion-item>
    </template>

    <template v-else-if="block.type === 'enquiry_form' || block.type === 'demo_form'">
      <ion-item
        ><ion-textarea v-model="s.intro" label="Intro" label-placement="stacked" :auto-grow="true"
      /></ion-item>
      <RefSelect
        v-if="block.type === 'demo_form'"
        v-model="s.courseId"
        label="Course"
        empty-label="Any course"
        :options="courses"
      />
      <RefSelect v-model="s.branchId" label="Branch" empty-label="Default branch" :options="branches" />
      <template v-if="block.type === 'demo_form'">
        <ion-list-header><ion-label>Demo class slots</ion-label></ion-list-header>
        <ion-item v-for="(slot, i) in s.slots" :key="i">
          <ion-input
            v-model="slot.label"
            label="Slot"
            label-placement="stacked"
            placeholder="Sat 10 AM – Physics"
          />
          <ion-input
            v-model="slot.startsAt"
            type="datetime-local"
            label="Starts at"
            label-placement="stacked"
          />
          <ion-button slot="end" fill="clear" color="danger" @click="s.slots!.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-button fill="clear" size="small" @click="s.slots!.push({ label: '', startsAt: null })"
          >+ Add slot</ion-button
        >
      </template>
      <ion-item
        ><ion-input v-model="s.submitLabel" label="Submit button label" label-placement="stacked"
      /></ion-item>
      <ion-item>
        <ion-input v-model="s.successMessage" label="Success message" label-placement="stacked" />
      </ion-item>
      <ion-item lines="none">
        <ion-note>Submissions arrive in Admissions → Enquiries with source “website”.</ion-note>
      </ion-item>
    </template>

    <template v-else-if="block.type === 'contact'">
      <ion-item
        ><ion-textarea v-model="s.address" label="Address" label-placement="stacked" :auto-grow="true"
      /></ion-item>
      <ion-item><ion-input v-model="s.phone" label="Phone" label-placement="stacked" /></ion-item>
      <ion-item
        ><ion-input v-model="s.email" type="email" label="Email" label-placement="stacked"
      /></ion-item>
      <ion-item>
        <ion-input
          v-model="s.mapQuery"
          label="Map location"
          label-placement="stacked"
          helper-text="Address or place name shown on an embedded map"
        />
      </ion-item>
    </template>

    <template v-else-if="block.type === 'cta'">
      <ion-item
        ><ion-textarea v-model="s.text" label="Text" label-placement="stacked" :auto-grow="true"
      /></ion-item>
      <ion-item
        ><ion-input v-model="s.buttonLabel" label="Button label" label-placement="stacked"
      /></ion-item>
      <LinkField v-model="s.buttonHref" :pages="pages" :courses="courses" />
    </template>
  </ion-list>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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
