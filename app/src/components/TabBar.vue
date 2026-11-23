<template>
  <nav class="tab-bar" :aria-label="t('shell.tabsLabel')">
    <a
      v-for="item in tabs"
      :key="item.path"
      class="tab"
      :class="{ active: current?.path === item.path }"
      :href="router.resolve(item.path).href"
      :aria-current="current?.path === item.path ? 'page' : undefined"
      @click.prevent="go(item.path)"
    >
      <ion-icon :icon="item.icon" aria-hidden="true" />
      <span class="label">{{ tabLabel(item) }}</span>
    </a>
    <button type="button" class="tab" :class="{ active: !current }" @click="openMore">
      <ion-icon :icon="gridOutline" aria-hidden="true" />
      <span class="label">{{ t('common.actions.more') }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { IonIcon, menuController, useIonRouter } from '@ionic/vue';
import { gridOutline } from 'ionicons/icons';
import type { MenuItem } from '@/core/modules';
import { activeItem } from '@/core/navigation';

/** Bottom tabs on phones: the persona's tabs plus "More", which opens the grouped menu. */
const props = defineProps<{ tabs: MenuItem[]; tabLabel: (item: MenuItem) => string }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const ionRouter = useIonRouter();

const current = computed(() => activeItem(props.tabs, route.path));

function go(path: string) {
  if (route.path !== path) ionRouter.navigate(path, 'root', 'replace');
}

const openMore = () => menuController.toggle();
</script>

<style scoped>
.tab-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: var(--app-tab-bar-offset, 0px);
  z-index: 20;
  display: flex;
  height: var(--app-tab-bar-height);
  padding-bottom: var(--app-tab-bar-safe-area, 0px);
  box-sizing: content-box;
  background: var(--ion-tab-bar-background, var(--ion-background-color, #fff));
  border-top: 1px solid var(--ion-border-color, rgba(0, 0, 0, 0.12));
}
.tab {
  flex: 1 1 0;
  min-width: 0;
  min-height: var(--app-tap-target);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 2px;
  border: 0;
  background: none;
  color: var(--ion-color-step-600, var(--ion-color-medium));
  font: inherit;
  font-size: 0.75rem;
  text-decoration: none;
  cursor: pointer;
}
.tab ion-icon {
  font-size: 1.5rem;
}
.tab .label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab.active {
  color: var(--ion-color-primary);
  font-weight: 600;
}
.tab:focus-visible {
  outline: 2px solid var(--ion-color-primary);
  outline-offset: -2px;
}
</style>
