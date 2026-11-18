<template>
  <AppPage title="Users & devices" :on-refresh="load">
    <p class="muted ion-padding-horizontal">
      Find any user on the platform to review the devices they are signed in on, or sign a device out.
    </p>
    <ion-searchbar
      v-model="search"
      :debounce="400"
      placeholder="Name, mobile or email (3+ characters)"
      @ion-input="load"
    />
    <ion-list>
      <ion-item v-for="u in users" :key="u.id" button detail @click="selected = u">
        <ion-label>
          <h2>
            {{ u.name }}
            <ion-badge v-if="u.isSuperAdmin" color="tertiary">super admin</ion-badge>
            <ion-badge v-if="u.status !== 'active'" color="medium">{{ u.status }}</ion-badge>
          </h2>
          <p>{{ [u.mobile, u.email].filter(Boolean).join(' · ') }}</p>
          <p>{{ u.institutes.map((i) => i.name).join(', ') || 'No institute' }}</p>
        </ion-label>
        <ion-note slot="end">{{ u.activeDevices }} signed in</ion-note>
      </ion-item>
      <ion-item v-if="searched && !users.length"
        ><ion-label class="muted">No users found.</ion-label></ion-item
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
import { IonBadge, IonItem, IonLabel, IonList, IonNote, IonSearchbar } from '@ionic/vue';
import type { PlatformUserDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import UserDevicesModal from '@/components/UserDevicesModal.vue';
import { toastError } from '@/core/toast';
import { adminApi } from './api';

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
