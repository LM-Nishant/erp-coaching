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
                <div class="brand-sub">{{ auth.isPlatformAdmin ? 'Platform admin' : roleLabel }}</div>
              </div>
            </div>
          </ion-toolbar>
        </ion-header>
        <ion-content>
          <ion-list v-if="branchOptions.length > 1" lines="none">
            <ion-item>
              <ion-select
                label="Branch"
                label-placement="stacked"
                interface="popover"
                :value="auth.activeBranchId ?? 0"
                @ion-change="changeBranch($event.detail.value)"
              >
                <ion-select-option :value="0">{{
                  auth.me?.allowedBranchIds ? 'All my branches' : 'All branches'
                }}</ion-select-option>
                <ion-select-option v-for="b in branchOptions" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-list>
            <ion-menu-toggle v-for="item in menu" :key="item.path" :auto-hide="false">
              <ion-item
                button
                :detail="false"
                lines="none"
                router-direction="root"
                :router-link="item.path"
                :class="{ selected: route.path.startsWith(item.path) }"
              >
                <ion-icon slot="start" :icon="item.icon" />
                <ion-label>{{ item.title }}</ion-label>
              </ion-item>
            </ion-menu-toggle>
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
              size="small"
              router-link="/select-institute"
            >
              Switch
            </ion-button>
            <ion-button
              v-if="auth.canSwitchProfile"
              slot="end"
              fill="clear"
              size="small"
              aria-label="Switch profile"
              title="Switch profile"
              @click="switchProfile"
            >
              <ion-icon slot="icon-only" :icon="peopleOutline" />
            </ion-button>
            <ion-button
              slot="end"
              fill="clear"
              size="small"
              color="danger"
              aria-label="Sign out"
              @click="logout"
            >
              <ion-icon slot="icon-only" :icon="logOutOutline" />
            </ion-button>
          </ion-item>
        </ion-footer>
      </ion-menu>
      <ion-router-outlet id="main" />
    </ion-split-pane>
    <ImpersonationBanner />
    <OfflineBanner />
    <BiometricOffer />
  </ion-app>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
  IonMenu,
  IonMenuToggle,
  IonRouterOutlet,
  IonSelect,
  IonSelectOption,
  IonSplitPane,
  IonToolbar,
} from '@ionic/vue';
import { logOutOutline, peopleOutline } from 'ionicons/icons';
import { appModules, fitsPersona } from '@/core/modules';
import { toastError } from '@/core/toast';
import { worksOffline } from '@/router';
import { useAuthStore } from '@/stores/auth';
import BiometricOffer from '@/components/BiometricOffer.vue';
import ImpersonationBanner from '@/components/ImpersonationBanner.vue';
import OfflineBanner from '@/components/OfflineBanner.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const institute = computed(() => auth.me?.institute ?? null);
const showMenu = computed(
  () => auth.isAuthenticated && !auth.needsInstitute && (!route.meta.public || !!route.meta.shell),
);
const roleLabel = computed(() => auth.me?.roles.map((r) => r.replace(/-/g, ' ')).join(', ') ?? '');
const branchOptions = computed(() => auth.me?.branches ?? []);
// Room for the banner at the bottom (impersonation / offline).
const paneStyle = computed(() =>
  auth.me?.impersonatedBy
    ? { bottom: '52px' }
    : auth.offline
      ? { bottom: 'calc(36px + var(--ion-safe-area-bottom, 0px))' }
      : undefined,
);

/** Role-aware menu built from every module's `menu` entries. */
const menu = computed(() =>
  appModules
    .flatMap((m) => m.menu ?? [])
    .filter((item) => {
      // Offline (app, cached profile): only pages that work without network.
      if (auth.offline && !worksOffline(router.resolve(item.path))) return false;
      if (item.visible && !item.visible()) return false;
      if (item.superAdmin) return auth.isPlatformAdmin;
      if (auth.isPlatformAdmin) return !item.permission;
      if (item.permission && !auth.can(item.permission)) return false;
      if (!fitsPersona(item, auth.me?.roles)) return false;
      return !item.planModule || auth.moduleEnabled(item.planModule);
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
);

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
    header: 'Switch profile?',
    message: `We'll send a code to ${user.mobile}. Then choose who's signing in; ${user.name} will be signed out on this device.`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Send code', role: 'confirm' },
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
  text-transform: capitalize;
}
ion-item.selected {
  --color: var(--ion-color-primary);
  --background: rgba(var(--ion-color-primary-rgb), 0.12);
}
</style>
