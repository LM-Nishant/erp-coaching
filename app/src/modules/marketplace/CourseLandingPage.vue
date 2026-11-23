<template>
  <MarketShell :title="course?.title ?? 'Course'" back-href="/market" wide :on-refresh="load">
    <div v-if="course" class="landing">
      <div class="main">
        <nav v-if="course.category" class="crumbs">
          <router-link :to="`/market/search?category=${course.category.slug}`">{{
            course.category.name
          }}</router-link>
          <template v-if="course.subcategory">
            ›
            <router-link :to="`/market/search?category=${course.subcategory.slug}`">{{
              course.subcategory.name
            }}</router-link>
          </template>
        </nav>
        <h1 data-testid="course-title">{{ course.title }}</h1>
        <p v-if="course.subtitle" class="subtitle">{{ course.subtitle }}</p>
        <p class="meta">
          <a v-if="course.ratingCount" href="#reviews" class="rating" @click.prevent="scrollToReviews"
            >{{ course.ratingAvg.toFixed(1) }} <RatingStars :rating="course.ratingAvg" /> ({{
              course.ratingCount
            }}
            {{ course.ratingCount === 1 ? 'rating' : 'ratings' }})</a
          >
          <span>{{ course.enrolmentCount }} {{ course.enrolmentCount === 1 ? 'learner' : 'learners' }}</span>
          <span>{{ MKT_COURSE_LEVEL_LABELS[course.level] }}</span>
          <span>{{ languageLabel(course.language) }}</span>
        </p>
        <p class="meta">
          Created by
          <router-link :to="`/market/instructor/${course.seller.slug}`">{{
            course.seller.displayName
          }}</router-link>
        </p>

        <div class="media">
          <StreamPlayer v-if="course.promo" :stream="course.promo" :poster="course.thumbnailUrl" />
          <img v-else-if="course.thumbnailUrl" :src="course.thumbnailUrl" alt="" />
        </div>

        <section v-if="course.outcomes.length" class="box">
          <h2>What you'll learn</h2>
          <ul class="outcomes">
            <li v-for="(o, i) in course.outcomes" :key="i">
              <ion-icon :icon="checkmarkOutline" />
              <span>{{ o }}</span>
            </li>
          </ul>
        </section>

        <section>
          <h2>Course content</h2>
          <p class="meta">
            {{ course.sections.length }} sections · {{ course.lectureCount }} lectures ·
            {{ durationLabel(course.durationSeconds) || '—' }} total
          </p>
          <ion-accordion-group :value="openSections" multiple>
            <ion-accordion v-for="s in course.sections" :key="s.id" :value="String(s.id)">
              <ion-item slot="header" color="light">
                <ion-label>{{ s.title }}</ion-label>
                <ion-note slot="end">{{ s.lectures.length }} lectures</ion-note>
              </ion-item>
              <ion-list slot="content" lines="none">
                <ion-item
                  v-for="l in s.lectures"
                  :key="l.id"
                  :button="l.preview"
                  :detail="false"
                  @click="l.preview && openPreview(l)"
                >
                  <ion-icon slot="start" :icon="lectureIcon(l.type)" />
                  <ion-label>{{ l.title }}</ion-label>
                  <ion-button
                    v-if="l.preview"
                    slot="end"
                    fill="clear"
                    size="small"
                    :data-testid="`preview-${l.id}`"
                    >Preview</ion-button
                  >
                  <ion-note slot="end">{{ l.durationSeconds ? clock(l.durationSeconds) : '' }}</ion-note>
                </ion-item>
              </ion-list>
            </ion-accordion>
          </ion-accordion-group>
        </section>

        <section v-if="course.requirements.length">
          <h2>Requirements</h2>
          <ul>
            <li v-for="(r, i) in course.requirements" :key="i">{{ r }}</li>
          </ul>
        </section>
        <section v-if="course.description">
          <h2>Description</h2>
          <p class="prose">{{ course.description }}</p>
        </section>
        <section v-if="course.audience.length">
          <h2>Who this course is for</h2>
          <ul>
            <li v-for="(r, i) in course.audience" :key="i">{{ r }}</li>
          </ul>
        </section>
        <section class="box">
          <h2>Instructor</h2>
          <router-link :to="`/market/instructor/${course.seller.slug}`" class="seller">
            <img v-if="course.seller.avatarUrl" :src="course.seller.avatarUrl" alt="" />
            <div v-else class="avatar">{{ course.seller.displayName.charAt(0) }}</div>
            <div>
              <strong>{{ course.seller.displayName }}</strong>
              <div class="meta">
                {{ course.seller.type === 'institute' ? 'Coaching institute' : 'Instructor' }}
              </div>
            </div>
          </router-link>
        </section>
        <ReviewsSection
          id="reviews"
          :course-id="course.id"
          :slug="course.slug"
          :enrolled="access.enrolled"
          @changed="onRatingChanged"
        />
      </div>

      <aside class="buy">
        <div class="buy-card">
          <img v-if="course.thumbnailUrl" :src="course.thumbnailUrl" alt="" class="buy-thumb" />
          <div class="price" data-testid="course-price">{{ priceLabel(course) }}</div>
          <template v-if="access.enrolled">
            <ion-button expand="block" :router-link="`/market/learn/${course.id}`" data-testid="go-to-course"
              >Go to course</ion-button
            >
          </template>
          <template v-else-if="course.isFree || course.pricePaise === 0">
            <ion-button expand="block" :disabled="busy" data-testid="enrol-free" @click="enrol"
              >Enrol for free</ion-button
            >
          </template>
          <template v-else>
            <ion-button v-if="access.inCart" expand="block" router-link="/market/cart">Go to cart</ion-button>
            <ion-button
              v-else
              expand="block"
              :disabled="busy"
              data-testid="add-to-cart"
              @click="addToCart(false)"
              >Add to cart</ion-button
            >
            <ion-button
              expand="block"
              fill="outline"
              :disabled="busy"
              data-testid="buy-now"
              @click="addToCart(true)"
              >Buy now</ion-button
            >
          </template>
          <WishlistButton v-if="!access.enrolled" :course-id="course.id" block />
          <ul class="includes">
            <li v-if="course.durationSeconds">{{ durationLabel(course.durationSeconds) }} of content</li>
            <li>{{ course.lectureCount }} lectures</li>
            <li>Watch on web, Android and iOS</li>
            <li>Lifetime access</li>
          </ul>
        </div>
      </aside>
    </div>
    <div v-else-if="!error" class="center"><ion-spinner /></div>
    <p v-if="error" class="muted center">{{ error }}</p>

    <ion-modal :is-open="!!preview" @did-dismiss="preview = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ preview?.title }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="preview = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <p class="meta">Free preview · {{ course?.title }}</p>
        <StreamPlayer v-if="preview?.stream" :stream="preview.stream" data-testid="preview-player" />
        <p v-else-if="preview?.articleBody" class="prose">{{ preview.articleBody }}</p>
        <div v-else class="center"><ion-spinner /></div>
      </ion-content>
    </ion-modal>
  </MarketShell>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { checkmarkOutline } from 'ionicons/icons';
import {
  MKT_COURSE_LEVEL_LABELS,
  type MktCourseDetailDto,
  type MktLectureOutlineDto,
  type MktReviewSummaryDto,
  type MktStreamDto,
} from '@erp/shared';
import { errorMessage } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import MarketShell from './components/MarketShell.vue';
import StreamPlayer from './components/StreamPlayer.vue';
import RatingStars from './components/RatingStars.vue';
import ReviewsSection from './components/ReviewsSection.vue';
import WishlistButton from './components/WishlistButton.vue';
import { clock, durationLabel, languageLabel, marketApi, priceLabel } from './api';
import { lectureIcon } from './lecture-icons';
import { useMarketAccount } from './store';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { refresh: refreshAccount } = useMarketAccount();
const course = ref<MktCourseDetailDto | null>(null);
const access = reactive({ enrolled: false, inCart: false });
const error = ref('');
const busy = ref(false);
const preview = ref<{ title: string; stream: MktStreamDto | null; articleBody: string | null } | null>(null);
const openSections = computed(() => (course.value?.sections[0] ? [String(course.value.sections[0].id)] : []));

async function load() {
  error.value = '';
  try {
    course.value = await marketApi.course(String(route.params.slug));
    if (auth.isAuthenticated && !auth.offline)
      Object.assign(access, await marketApi.access(course.value.id).catch(() => access));
    if (route.hash === '#reviews') setTimeout(scrollToReviews, 300);
  } catch (e) {
    error.value = errorMessage(e);
  }
}

/** Signed-out visitors sign in (or sign up) first and come back here. */
function needsSignIn() {
  if (auth.isAuthenticated) return false;
  void router.push({ name: 'login', query: { redirect: route.fullPath } });
  return true;
}

async function addToCart(checkout: boolean) {
  if (!course.value || needsSignIn()) return;
  busy.value = true;
  try {
    if (!access.inCart) await marketApi.addToCart(course.value.id);
    access.inCart = true;
    void refreshAccount();
    if (checkout) await router.push('/market/cart');
    else await toast('Added to cart');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function enrol() {
  if (!course.value || needsSignIn()) return;
  busy.value = true;
  try {
    await marketApi.enrolFree(course.value.id);
    access.enrolled = true;
    await router.push(`/market/learn/${course.value.id}`);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

function onRatingChanged(s: MktReviewSummaryDto) {
  if (course.value) Object.assign(course.value, { ratingAvg: s.ratingAvg, ratingCount: s.ratingCount });
}

function scrollToReviews() {
  document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' });
}

async function openPreview(l: MktLectureOutlineDto) {
  preview.value = { title: l.title, stream: null, articleBody: null };
  try {
    const p = await marketApi.preview(l.id);
    preview.value = { title: p.title, stream: p.stream, articleBody: p.articleBody };
  } catch (e) {
    preview.value = null;
    void toastError(e);
  }
}

watch(
  () => route.params.slug,
  (slug) => slug && void load(),
  { immediate: true },
);
</script>

<style scoped>
.landing {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 24px;
  align-items: start;
}
@media (max-width: 900px) {
  .landing {
    grid-template-columns: 1fr;
  }
  .buy {
    order: -1;
  }
  .buy-thumb {
    display: none;
  }
}
.crumbs {
  font-size: 13px;
}
h1 {
  margin: 4px 0;
  font-size: clamp(22px, 3.5vw, 32px);
}
.subtitle {
  font-size: 17px;
  margin: 4px 0 8px;
}
.meta {
  color: var(--ion-color-medium-shade);
  font-size: 13px;
  margin: 4px 0;
}
.meta span + span::before {
  content: ' · ';
}
.rating {
  color: var(--ion-color-warning-shade);
  font-weight: 600;
  text-decoration: none;
}
.media {
  margin: 16px 0;
}
.media img {
  width: 100%;
  border-radius: 8px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}
.box {
  border: 1px solid var(--ion-color-light-shade);
  border-radius: 12px;
  padding: 4px 16px 12px;
  margin: 16px 0;
}
h2 {
  font-size: 19px;
}
.outcomes {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.outcomes li {
  display: flex;
  gap: 8px;
}
.outcomes ion-icon {
  flex: none;
  margin-top: 3px;
}
.prose {
  white-space: pre-wrap;
  line-height: 1.55;
}
.buy {
  position: sticky;
  top: 8px;
}
.buy-card {
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  padding: 12px;
  background: var(--ion-background-color);
}
.buy-thumb {
  width: 100%;
  border-radius: 8px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}
.price {
  font-size: 28px;
  font-weight: 700;
  margin: 8px 0;
}
.includes {
  font-size: 13px;
  color: var(--ion-color-medium-shade);
  padding-left: 18px;
}
.seller {
  display: flex;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-decoration: none;
}
.seller img,
.avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ion-color-primary);
  color: #fff;
  font-size: 22px;
  font-weight: 700;
}
.center {
  text-align: center;
  padding: 40px;
}
.muted {
  color: var(--ion-color-medium);
}
</style>
