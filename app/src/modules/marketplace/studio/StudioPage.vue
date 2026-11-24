<template>
  <AppPage :title="scope === 'institute' ? 'Storefront courses' : 'Instructor studio'" :on-refresh="load">
    <template #actions>
      <ion-button :aria-label="'Edit profile'" @click="profileOpen = true">
        <ion-icon slot="icon-only" :icon="personCircleOutline" />
      </ion-button>
    </template>
    <div v-if="profile" class="head">
      <div>
        <h2>{{ profile.displayName }}</h2>
        <p class="muted">
          <router-link :to="`/market/instructor/${profile.slug}`">Public page</router-link>
          <template v-if="profile.status === 'suspended'">
            · <ion-text color="danger">Suspended</ion-text></template
          >
        </p>
      </div>
      <div class="links">
        <ion-button fill="outline" size="small" :router-link="`/market/studio/${scope}/coupons`"
          >Coupons</ion-button
        >
        <ion-button fill="outline" size="small" :router-link="`/market/studio/${scope}/sales`"
          >Sales</ion-button
        >
        <ion-button
          fill="outline"
          size="small"
          :router-link="`/market/studio/${scope}/engagement`"
          data-testid="studio-engagement"
          >Q&amp;A and reviews</ion-button
        >
        <ion-button
          fill="outline"
          size="small"
          :router-link="`/market/studio/${scope}/revenue`"
          data-testid="open-revenue"
          >Revenue &amp; payouts</ion-button
        >
        <ion-button v-if="canCreate" size="small" data-testid="new-course" @click="create"
          >New course</ion-button
        >
      </div>
    </div>

    <ion-list v-if="courses.length">
      <ion-item
        v-for="c in courses"
        :key="c.id"
        :router-link="`/market/studio/${scope}/courses/${c.id}`"
        detail
        :data-testid="`studio-course-${c.id}`"
      >
        <ion-thumbnail slot="start">
          <img v-if="c.thumbnail?.url" :src="c.thumbnail.url" alt="" />
        </ion-thumbnail>
        <ion-label>
          <h3>{{ c.title }}</h3>
          <p>
            {{ c.lectureCount }} lectures · {{ c.enrolmentCount }} learners ·
            {{ c.pricePaise ? rupees(c.pricePaise) : 'Free' }}
          </p>
          <p v-if="c.status === 'rejected' && c.reviewNote" class="reject">
            Changes requested: {{ c.reviewNote }}
          </p>
        </ion-label>
        <ion-badge slot="end" :color="STATUS_COLORS[c.status]">{{
          MKT_COURSE_STATUS_LABELS[c.status]
        }}</ion-badge>
      </ion-item>
    </ion-list>
    <p v-else-if="loaded" class="empty">No courses yet. Start with "New course".</p>

    <ion-modal :is-open="profileOpen" @did-dismiss="profileOpen = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Profile</ion-title>
          <ion-buttons slot="end"><ion-button @click="profileOpen = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ProfileForm
          v-if="profile"
          :profile="profile"
          :busy="busy"
          submit-label="Save profile"
          @save="saveProfile"
        />
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  alertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonText,
  IonThumbnail,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { personCircleOutline } from 'ionicons/icons';
import {
  MKT_COURSE_STATUS_LABELS,
  type MktInstructorProfileInput,
  type MktSellerAdminDto,
  type MktStudioCourseDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import ProfileForm from './ProfileForm.vue';
import { marketApi, rupees, studioApi, type StudioScope } from '../api';
import { STATUS_COLORS } from './status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const scope = computed(() => route.params.scope as StudioScope);
const studio = computed(() => studioApi(scope.value));
const canCreate = computed(() => scope.value === 'instructor' || auth.can('marketplace.create'));
const profile = ref<MktSellerAdminDto | null>(null);
const courses = ref<MktStudioCourseDto[]>([]);
const loaded = ref(false);
const busy = ref(false);
const profileOpen = ref(false);

async function load() {
  try {
    [profile.value, courses.value] = await Promise.all([studio.value.profile(), studio.value.courses()]);
  } catch (e) {
    // No instructor profile yet: create one first.
    if (e instanceof ApiError && e.status === 404 && scope.value === 'instructor')
      return router.replace('/market/teach');
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function create() {
  const alert = await alertController.create({
    header: 'New course',
    message: 'Working title. You can change it later.',
    inputs: [{ name: 'title', placeholder: 'e.g. Python for beginners', attributes: { maxlength: 160 } }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Create', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { title: string } }>();
  const title = data?.values.title?.trim();
  if (role !== 'confirm' || !title) return;
  try {
    const c = await studio.value.createCourse({ title });
    await router.push(`/market/studio/${scope.value}/courses/${c.id}`);
  } catch (e) {
    void toastError(e);
  }
}

async function saveProfile(input: MktInstructorProfileInput) {
  busy.value = true;
  try {
    profile.value =
      scope.value === 'instructor'
        ? await marketApi.saveInstructorProfile(input)
        : await studio.value.saveProfile(input);
    profileOpen.value = false;
    await toast('Profile saved');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

watch(scope, (s) => s && void load(), { immediate: true });
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.head h2 {
  margin: 0;
}
.links {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
ion-thumbnail {
  --size: 64px;
  --border-radius: 6px;
}
.muted {
  color: var(--ion-color-medium);
  margin: 4px 0;
}
.reject {
  color: var(--ion-color-danger) !important;
}
.empty {
  text-align: center;
  padding: 32px;
  color: var(--ion-color-medium);
}
</style>
