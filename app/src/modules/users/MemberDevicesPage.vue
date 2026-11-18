<template>
  <AppPage title="Member devices" :on-refresh="load">
    <p class="muted ion-padding-horizontal">
      Devices your staff, students and parents are signed in on.
      <template v-if="branchScoped">You can manage members of your branches.</template>
    </p>
    <ion-searchbar v-model="search" :debounce="300" placeholder="Name, mobile or email" @ion-input="load" />
    <ion-list>
      <ion-item v-for="u in users" :key="u.id" button detail @click="selected = u">
        <ion-label>
          <h2>
            {{ u.name }}
            <ion-badge v-if="u.status !== 'active'" color="medium">{{ u.status }}</ion-badge>
          </h2>
          <p>{{ [u.mobile, u.email].filter(Boolean).join(' · ') }}</p>
        </ion-label>
        <ion-note slot="end">{{ u.activeDevices }} signed in</ion-note>
      </ion-item>
      <ion-item v-if="loaded && !users.length"
        ><ion-label class="muted">No members found.</ion-label></ion-item
      >
    </ion-list>

    <UserDevicesModal
      :user="selected"
      base-path="/users"
      :can-revoke="auth.can('users.edit')"
      @close="selected = null"
      @changed="load"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList, IonNote, IonSearchbar } from '@ionic/vue';
import type { DeviceUserDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import UserDevicesModal from '@/components/UserDevicesModal.vue';
import { api } from '@/core/api';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const search = ref('');
const users = ref<DeviceUserDto[]>([]);
const loaded = ref(false);
const selected = ref<DeviceUserDto | null>(null);
const branchScoped = computed(() => !!auth.me && auth.me.allowedBranchIds !== null);

async function load() {
  try {
    users.value = await api.get<DeviceUserDto[]>('/users/devices', {
      search: search.value.trim() || undefined,
    });
    loaded.value = true;
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>
