<template>
  <AppPage :title="t('parentPortal.home.title')" :on-refresh="load">
    <header class="hello">
      <div class="avatar" aria-hidden="true">{{ initial }}</div>
      <h2>{{ t('parentPortal.home.greeting', { name: firstName }) }}</h2>
    </header>

    <!-- Child switcher: big pills, one per child; the choice is remembered on this device. -->
    <div
      v-if="children.length > 1"
      class="children"
      role="tablist"
      :aria-label="t('parentPortal.home.chooseChild')"
    >
      <button
        v-for="c in children"
        :key="c.studentId"
        type="button"
        role="tab"
        class="child"
        :class="{ active: c.studentId === studentId }"
        :aria-selected="c.studentId === studentId"
        @click="studentId = c.studentId"
      >
        {{ c.name.split(' ')[0] }}
      </button>
    </div>

    <EmptyState
      v-if="!loading && !children.length"
      :icon="peopleOutline"
      :title="t('parentPortal.home.noChildren')"
      :message="t('parentPortal.home.noChildrenHint')"
    />

    <template v-if="child">
      <p class="muted subtitle">
        <strong>{{ child.name }}</strong>
        <span v-if="child.admissionNumber"> · {{ child.admissionNumber }}</span>
        <span v-if="child.batches.length"> · {{ child.batches.map((b) => b.name).join(', ') }}</span>
      </p>
      <!-- `:key` remounts every card when the child changes, so widgets may also load once on mount. -->
      <div :key="`${child.studentId}-${refreshKey}`" class="widgets">
        <section v-for="w in widgets" :key="w.id" :class="['widget', w.size ?? 'half']">
          <h3 class="eyebrow">{{ title(w) }}</h3>
          <component :is="w.component" :child="child" />
        </section>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { peopleOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { ParentChildDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { widgetsFor } from '@/core/modules';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { useWidgetTitle } from '../dashboard/widget-title';
import { parentPortalApi } from './api';

const STORAGE_KEY = 'parent-home.child';

const auth = useAuthStore();
const { t } = useI18n();
const title = useWidgetTitle();
const firstName = computed(() => auth.me?.user.name.split(' ')[0] ?? '');
const initial = computed(() => firstName.value.charAt(0).toUpperCase());
const children = ref<ParentChildDto[]>([]);
const studentId = ref<number | undefined>(Number(localStorage.getItem(STORAGE_KEY)) || undefined);
watch(studentId, (id) => id && localStorage.setItem(STORAGE_KEY, String(id)));
const loading = ref(true);
const refreshKey = ref(0);

const child = computed(() => children.value.find((c) => c.studentId === studentId.value) ?? null);
const widgets = computed(() =>
  widgetsFor('parent-home').filter(
    (w) => (!w.permission || auth.can(w.permission)) && (!w.planModule || auth.moduleEnabled(w.planModule)),
  ),
);

async function load() {
  loading.value = true;
  try {
    children.value = await parentPortalApi.children();
    if (!children.value.some((c) => c.studentId === studentId.value)) {
      studentId.value = children.value[0]?.studentId;
    }
    refreshKey.value++;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.hello {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 4px 12px;
}
.hello h2 {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
}
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  font-weight: 700;
  font-size: 1.2rem;
  color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
}
.children {
  display: flex;
  gap: 4px;
  padding: 4px;
  margin-bottom: 8px;
  border-radius: 14px;
  background: var(--ion-color-light);
  overflow-x: auto;
}
.child {
  flex: 1 0 auto;
  min-height: var(--app-tap-target, 48px);
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  font: inherit;
  font-weight: 600;
  color: var(--ion-color-medium-shade);
  background: transparent;
  cursor: pointer;
}
.child.active {
  color: var(--ion-text-color);
  background: var(--ion-background-color, #fff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.subtitle {
  margin: 4px 4px 12px;
}
.widgets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.widget {
  padding: 16px;
  border-radius: 16px;
  background: var(--ion-card-background, var(--ion-item-background, #fff));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  min-width: 0;
}
.widget.full {
  grid-column: 1 / -1;
}
.eyebrow {
  margin: 0 0 10px;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ion-color-medium-shade);
}
@media (max-width: 768px) {
  .widgets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
