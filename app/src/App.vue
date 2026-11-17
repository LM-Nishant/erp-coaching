<template>
  <ion-app>
    <ion-split-pane
      content-id="main"
      when="lg"
      :disabled="!showMenu"
      :style="auth.me?.impersonatedBy ? { bottom: '52px' } : undefined"
    >
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
            <ion-button slot="end" fill="clear" size="small" color="danger" @click="logout">
              <ion-icon slot="icon-only" :icon="logOutOutline" />
            </ion-button>
          </ion-item>
        </ion-footer>
      </ion-menu>
      <ion-router-outlet id="main" />
    </ion-split-pane>
    <ImpersonationBanner />
  </ion-app>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
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
import { logOutOutline } from 'ionicons/icons';
import { appModules } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';
import ImpersonationBanner from '@/components/ImpersonationBanner.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const institute = computed(() => auth.me?.institute ?? null);
const showMenu = computed(() => auth.isAuthenticated && !auth.needsInstitute && !route.meta.public);
const roleLabel = computed(() => auth.me?.roles.map((r) => r.replace(/-/g, ' ')).join(', ') ?? '');
const branchOptions = computed(() => auth.me?.branches ?? []);

/** Role-aware menu built from every module's `menu` entries. */
const menu = computed(() =>
  appModules
    .flatMap((m) => m.menu ?? [])
    .filter((item) => {
      if (item.superAdmin) return auth.isPlatformAdmin;
      if (auth.isPlatformAdmin) return !item.permission;
      if (item.permission && !auth.can(item.permission)) return false;
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
