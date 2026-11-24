<template>
  <ion-app>
    <ion-split-pane content-id="main" when="lg" :disabled="!showMenu" :style="paneStyle">
      <ion-menu content-id="main" type="overlay" :disabled="!showMenu">
        <ion-header>
          <ion-toolbar color="primary">
            <div class="brand">
              <img v-if="institute?.logoUrl" :src="institute.logoUrl" alt="" />
              <div>
                <div class="brand-name">{{ institute?.name ?? 'ERP Coaching' }}</div>
                <div class="brand-sub">{{ auth.isPlatformAdmin ? t('shell.platformAdmin') : roleLabel }}</div>
              </div>
            </div>
          </ion-toolbar>
        </ion-header>
        <ion-content>
          <ion-list v-if="branchOptions.length > 1" lines="none">
            <ion-item>
              <ion-select
                :label="t('shell.branch')"
                label-placement="stacked"
                interface="popover"
                :value="auth.activeBranchId ?? 0"
                @ion-change="changeBranch($event.detail.value)"
              >
                <ion-select-option :value="0">{{
                  auth.me?.allowedBranchIds ? t('shell.allMyBranches') : t('shell.allBranches')
                }}</ion-select-option>
                <ion-select-option v-for="b in branchOptions" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-searchbar
            v-if="items.length > 8"
            v-model="query"
            class="menu-search"
            :placeholder="t('shell.searchMenu')"
            :aria-label="t('shell.searchMenu')"
          />
          <template v-if="query.trim()">
            <ion-list>
              <ion-menu-toggle v-for="item in found" :key="item.path" :auto-hide="false">
                <ion-item
                  button
                  :detail="false"
                  lines="none"
                  router-direction="root"
                  :router-link="item.path"
                  @click="query = ''"
                >
                  <ion-icon slot="start" :icon="item.icon" />
                  <ion-label>{{ label(item) }}</ion-label>
                </ion-item>
              </ion-menu-toggle>
            </ion-list>
            <p v-if="!found.length" class="no-match">{{ t('shell.noMatch', { query: query.trim() }) }}</p>
          </template>
          <template v-else>
            <ion-list v-for="g in groups" :key="g.group" class="menu-group">
              <ion-list-header v-if="groups.length > 1">{{
                t(`common.menuGroups.${g.group}`)
              }}</ion-list-header>
              <ion-menu-toggle v-for="item in g.items" :key="item.path" :auto-hide="false">
                <ion-item
                  button
                  :detail="false"
                  lines="none"
                  router-direction="root"
                  :router-link="item.path"
                  :class="{ selected: current?.path === item.path }"
                >
                  <ion-icon slot="start" :icon="item.icon" />
                  <ion-label>{{ label(item) }}</ion-label>
                </ion-item>
              </ion-menu-toggle>
            </ion-list>
          </template>
          <ion-list class="menu-group display">
            <ion-list-header>{{ t('shell.display') }}</ion-list-header>
            <ion-item lines="none">
              <ion-select
                :label="t('common.language')"
                interface="popover"
                :value="locale"
                @ion-change="changeLocale($event.detail.value)"
              >
                <ion-select-option v-for="l in LOCALES" :key="l" :value="l">{{
                  LOCALE_NAMES[l]
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item lines="none">
              <ion-select
                :label="t('shell.textSize')"
                interface="popover"
                :value="textSize"
                @ion-change="changeTextSize($event.detail.value)"
              >
                <ion-select-option v-for="s in TEXT_SIZES" :key="s" :value="s">{{
                  t(`shell.textSizes.${s}`)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
        </ion-content>
        <ion-footer>
          <ion-item lines="none">
            <ion-label>
              <div>{{ auth.me?.user.name }}</div>
              <p>{{ auth.me?.user.mobile }}</p>
            </ion-label>
            <ion-button
              v-if="(auth.me?.memberships.length ?? 0) > 1 && !auth.me?.impersonatedBy"
              slot="end"
              fill="clear"
              router-link="/select-institute"
            >
              {{ t('shell.switchInstitute') }}
            </ion-button>
            <ion-button
              v-if="auth.canSwitchProfile"
              slot="end"
              fill="clear"
              :aria-label="t('shell.switchProfile')"
              :title="t('shell.switchProfile')"
              @click="switchProfile"
            >
              <ion-icon slot="icon-only" :icon="peopleOutline" />
            </ion-button>
            <ion-button
              slot="end"
              fill="clear"
              color="danger"
              :aria-label="t('shell.signOut')"
              :title="t('shell.signOut')"
              @click="logout"
            >
              <ion-icon slot="icon-only" :icon="logOutOutline" />
            </ion-button>
          </ion-item>
        </ion-footer>
      </ion-menu>
      <ion-router-outlet id="main" />
    </ion-split-pane>
    <TabBar v-if="showTabs" :tabs="tabs" :tab-label="tabLabel" :style="tabBarStyle" />
    <ImpersonationBanner />
    <OfflineBanner />
    <BiometricOffer />
  </ion-app>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  alertController,
  menuController,
  IonApp,
  IonButton,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonMenu,
  IonMenuToggle,
  IonRouterOutlet,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonSplitPane,
  IonToolbar,
} from '@ionic/vue';
import { logOutOutline, peopleOutline } from 'ionicons/icons';
import type { MenuItem } from '@/core/modules';
import { activeItem, searchMenu, useMenu } from '@/core/navigation';
import { toastError } from '@/core/toast';
import { LOCALE_NAMES, LOCALES, type Locale } from '@/i18n';
import { chooseLocale } from '@/core/locale-sync';
import { roleNames } from '@/core/roles';
import { useAuthStore } from '@/stores/auth';
import { applyTextSize, storedTextSize, TEXT_SIZES, type TextSize } from '@/theme/text-size';
import BiometricOffer from '@/components/BiometricOffer.vue';
import ImpersonationBanner from '@/components/ImpersonationBanner.vue';
import OfflineBanner from '@/components/OfflineBanner.vue';
import TabBar from '@/components/TabBar.vue';

const auth = useAuthStore();

/** Switches the language and saves it on the account, so the user's other devices open in it too. */
async function changeLocale(l: Locale) {
  try {
    await chooseLocale(l, auth.me);
  } catch (e) {
    await toastError(e);
  }
}
const route = useRoute();
const router = useRouter();
const { t, locale: i18nLocale } = useI18n();
const { items, tabs, groups, label, tabLabel } = useMenu();

const institute = computed(() => auth.me?.institute ?? null);
const showMenu = computed(
  () => auth.isAuthenticated && !auth.needsInstitute && (!route.meta.public || !!route.meta.shell),
);
const roleLabel = computed(() => roleNames(auth.me?.roles, t));
const branchOptions = computed(() => auth.me?.branches ?? []);

// The split pane shows the menu beside the page from Ionic's `lg` breakpoint; below it, phones get tabs.
const wide = window.matchMedia('(min-width: 992px)');
const isWide = ref(wide.matches);
const onWide = (e: MediaQueryListEvent) => (isWide.value = e.matches);
wide.addEventListener('change', onWide);
onBeforeUnmount(() => wide.removeEventListener('change', onWide));
const showTabs = computed(() => showMenu.value && !isWide.value && tabs.value.length > 0);

// Room at the bottom for the banner (impersonation / offline) and the tab bar.
const bannerHeight = computed(() =>
  auth.me?.impersonatedBy ? '52px' : auth.offline ? 'calc(36px + var(--ion-safe-area-bottom, 0px))' : null,
);
const tabBarStyle = computed(() => ({
  '--app-tab-bar-offset': bannerHeight.value ?? '0px',
  '--app-tab-bar-safe-area': bannerHeight.value ? '0px' : 'var(--ion-safe-area-bottom, 0px)',
}));
const paneStyle = computed(() => {
  if (showTabs.value)
    return {
      bottom: bannerHeight.value
        ? `calc(${bannerHeight.value} + var(--app-tab-bar-height))`
        : 'calc(var(--app-tab-bar-height) + var(--ion-safe-area-bottom, 0px))',
    };
  return bannerHeight.value ? { bottom: bannerHeight.value } : undefined;
});

const current = computed(() => activeItem(items.value, route.path));

const query = ref('');
const groupLabel = (item: MenuItem) => t(`common.menuGroups.${item.group ?? 'other'}`);
const found = computed(() => searchMenu(items.value, query.value, label, groupLabel));

const locale = computed(() => i18nLocale.value as Locale);
const textSize = ref<TextSize>(storedTextSize());
applyTextSize(textSize.value, false);
function changeTextSize(size: TextSize) {
  textSize.value = size;
  applyTextSize(size);
}

async function changeBranch(value: number) {
  await auth.setActiveBranch(value || null);
  // Reload the current page so lists re-query with the new X-Branch-Id.
  await router.replace({ path: '/home', query: { b: String(value) } });
}

async function logout() {
  await auth.logout();
  await router.replace({ name: 'login' });
}

/** Another account on this number (e.g. a sibling on a parent's mobile): verify the number again, then choose. */
async function switchProfile() {
  const user = auth.me?.user;
  if (!user) return;
  const alert = await alertController.create({
    header: t('shell.switchProfileConfirm.header'),
    message: t('shell.switchProfileConfirm.message', { mobile: user.mobile, name: user.name }),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      { text: t('shell.switchProfileConfirm.send'), role: 'confirm' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'confirm') return;
  try {
    const next = await auth.startProfileSwitch();
    await menuController.close();
    if (next === 'otp') await router.push({ name: 'otp' });
    // Without a code (AUTH_DEV_SKIP_OTP in local development) the API answers with the profiles at once.
    else if (next === 'choose-profile') await router.push({ name: 'choose-profile' });
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}
.brand img {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
}
.brand-name {
  font-weight: 600;
}
.brand-sub {
  font-size: 12px;
  opacity: 0.85;
}
.menu-search {
  padding: 8px 12px 0;
}
.menu-group ion-list-header {
  min-height: 32px;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
.menu-group ion-item {
  --min-height: var(--app-tap-target);
}
.no-match {
  padding: 0 16px;
  color: var(--ion-color-medium);
}
ion-item.selected {
  --color: var(--ion-color-primary);
  --background: rgba(var(--ion-color-primary-rgb), 0.12);
}
</style>
