<template>
  <AppPage :title="t('admin.users.title')" :on-refresh="load">
    <p class="muted ion-padding-horizontal">{{ t('admin.users.intro') }}</p>
    <ion-searchbar
      v-model="search"
      :debounce="400"
      :placeholder="t('admin.users.searchPlaceholder')"
      @ion-input="load"
    />
    <ion-list>
      <ion-item v-for="u in users" :key="u.id" button detail @click="selected = u">
        <ion-label>
          <h2>
            {{ u.name }}
            <StatusChip v-if="u.isSuperAdmin" :label="t('admin.users.superAdmin')" tone="primary" />
            <StatusChip v-if="u.status !== 'active'" :label="statusLabel(u.status)" />
          </h2>
          <p>{{ [u.mobile, u.email].filter(Boolean).join(' · ') }}</p>
          <p>{{ u.institutes.map((i) => i.name).join(', ') || t('admin.users.noInstitute') }}</p>
        </ion-label>
        <ion-note slot="end">{{ t('admin.users.signedIn', { n: formatNumber(u.activeDevices) }) }}</ion-note>
      </ion-item>
      <ion-item v-if="searched && !users.length"
        ><ion-label class="muted">{{ t('admin.users.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <UserDevicesModal
      :user="selected"
      base-path="/admin/users"
      can-revoke
      @close="selected = null"
      @changed="load"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonItem, IonLabel, IonList, IonNote, IonSearchbar } from '@ionic/vue';
import type { PlatformUserDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import UserDevicesModal from '@/components/UserDevicesModal.vue';
import { formatNumber } from '@/core/format';
import { toastError } from '@/core/toast';
import { adminApi, statusLabel } from './api';

const { t } = useI18n();
const search = ref('');
const users = ref<PlatformUserDto[]>([]);
const searched = ref(false);
const selected = ref<PlatformUserDto | null>(null);

async function load() {
  const q = search.value.trim();
  if (q.length < 3) {
    users.value = [];
    searched.value = false;
    return;
  }
  try {
    users.value = await adminApi.users(q);
    searched.value = true;
  } catch (e) {
    await toastError(e);
  }
}
</script>
