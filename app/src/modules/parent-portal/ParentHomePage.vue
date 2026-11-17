<template>
  <AppPage :title="child ? child.name : 'Parent home'" :on-refresh="load">
    <ion-segment v-if="children.length > 1" v-model="studentId" scrollable class="children">
      <ion-segment-button v-for="c in children" :key="c.studentId" :value="c.studentId">
        <ion-label>{{ c.name }}</ion-label>
      </ion-segment-button>
    </ion-segment>

    <ion-list v-if="!loading && !children.length">
      <ion-item>
        <ion-label class="muted ion-text-wrap">
          No children are linked to your account yet. Please contact the institute.
        </ion-label>
      </ion-item>
    </ion-list>

    <template v-if="child">
      <p class="muted subtitle">
        <span v-if="child.admissionNumber">{{ child.admissionNumber }}</span>
        <span v-if="child.branchName"> · {{ child.branchName }}</span>
        <span v-if="child.batches.length"> · {{ child.batches.map((b) => b.name).join(', ') }}</span>
      </p>
      <!-- `:key` remounts every card when the child changes, so widgets may also load once on mount. -->
      <div :key="`${child.studentId}-${refreshKey}`" class="widgets">
        <ion-card v-for="w in widgets" :key="w.id" :class="['widget', w.size ?? 'half']">
          <ion-card-header>
            <ion-card-title>{{ w.title }}</ion-card-title>
          </ion-card-header>
          <ion-card-content>
            <component :is="w.component" :child="child" />
          </ion-card-content>
        </ion-card>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import type { ParentChildDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { widgetsFor } from '@/core/modules';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { parentPortalApi } from './api';

const STORAGE_KEY = 'parent-home.child';

const auth = useAuthStore();
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
.children {
  margin-bottom: 8px;
}
.subtitle {
  margin: 4px 16px 0;
}
.widgets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
}
.widget.full {
  grid-column: 1 / -1;
}
@media (max-width: 768px) {
  .widgets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
