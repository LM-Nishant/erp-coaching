<template>
  <AppPage title="Marketplace settings" :on-refresh="load">
    <h3>Commission</h3>
    <form v-if="settings" @submit.prevent="saveSettings">
      <ion-list>
        <ion-item>
          <ion-input
            v-model.number="settings.commissionPercent"
            type="number"
            min="0"
            max="100"
            label="Platform commission on each sale (%)"
            label-placement="stacked"
            data-testid="commission-percent"
          />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="settings.instructorSignupOpen">Anyone can sign up to teach</ion-toggle>
        </ion-item>
      </ion-list>
      <p class="muted">Changes apply to new sales only. Sellers can have their own rate below.</p>
      <ion-button type="submit" :disabled="busy">Save settings</ion-button>
    </form>

    <h3>Sellers</h3>
    <ion-searchbar v-model="q" placeholder="Search sellers" :debounce="300" @ion-input="loadSellers" />
    <ion-list>
      <ion-item v-for="s in sellers" :key="s.id">
        <ion-label>
          <h3>{{ s.displayName }}</h3>
          <p>
            {{ s.type === 'institute' ? 'Institute' : 'Independent instructor' }} ·
            {{ s.courseCount }} courses · commission
            {{ s.commissionPercent ?? settings?.commissionPercent }}%{{
              s.commissionPercent === null ? ' (default)' : ''
            }}
          </p>
        </ion-label>
        <ion-button slot="end" fill="clear" @click="editCommission(s)">Commission</ion-button>
        <ion-button
          slot="end"
          fill="clear"
          :color="s.status === 'active' ? 'danger' : 'success'"
          @click="toggleSeller(s)"
        >
          {{ s.status === 'active' ? 'Suspend' : 'Reinstate' }}
        </ion-button>
      </ion-item>
    </ion-list>

    <h3>Categories</h3>
    <ion-list>
      <template v-for="c in categories" :key="c.id">
        <ion-item>
          <ion-label>
            <strong>{{ c.name }}</strong>
            <p>{{ c.courseCount }} courses</p>
          </ion-label>
          <ion-button slot="end" fill="clear" @click="editCategory(c.id, c.name, null)">Rename</ion-button>
          <ion-button slot="end" fill="clear" @click="editCategory(null, '', c.id)"
            >Add subcategory</ion-button
          >
          <ion-button slot="end" fill="clear" color="danger" @click="removeCategory(c.id)">Delete</ion-button>
        </ion-item>
        <ion-item v-for="sc in c.children" :key="sc.id" class="child">
          <ion-label>{{ sc.name }}</ion-label>
          <ion-button slot="end" fill="clear" @click="editCategory(sc.id, sc.name, c.id)">Rename</ion-button>
          <ion-button slot="end" fill="clear" color="danger" @click="removeCategory(sc.id)"
            >Delete</ion-button
          >
        </ion-item>
      </template>
    </ion-list>
    <ion-button fill="outline" @click="editCategory(null, '', null)">Add category</ion-button>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  alertController,
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonToggle,
} from '@ionic/vue';
import type { MktCategoryDto, MktSellerAdminDto, MktSettingsDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { adminMarketApi, marketApi } from '../api';

const settings = ref<MktSettingsDto | null>(null);
const sellers = ref<MktSellerAdminDto[]>([]);
const categories = ref<MktCategoryDto[]>([]);
const q = ref('');
const busy = ref(false);

async function guard<T>(fn: () => Promise<T>, done?: string) {
  busy.value = true;
  try {
    const r = await fn();
    if (done) await toast(done);
    return r;
  } catch (e) {
    void toastError(e);
    return undefined;
  } finally {
    busy.value = false;
  }
}

async function loadSellers() {
  sellers.value = (await guard(() => adminMarketApi.sellers({ q: q.value || undefined }))) ?? [];
}
async function load() {
  settings.value = (await guard(() => adminMarketApi.settings())) ?? null;
  categories.value = (await guard(() => marketApi.categories())) ?? [];
  await loadSellers();
}

async function saveSettings() {
  const s = settings.value;
  if (!s) return;
  const r = await guard(
    () =>
      adminMarketApi.saveSettings({
        commissionPercent: Number(s.commissionPercent),
        instructorSignupOpen: s.instructorSignupOpen,
      }),
    'Settings saved',
  );
  if (r) settings.value = r;
}

async function ask(header: string, value: string, type: 'text' | 'number', placeholder = '') {
  const alert = await alertController.create({
    header,
    inputs: [{ name: 'v', type, value, placeholder }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { v: string } }>();
  return role === 'confirm' ? (data?.values.v ?? '').trim() : null;
}

async function editCommission(s: MktSellerAdminDto) {
  const v = await ask(
    `Commission for ${s.displayName}`,
    s.commissionPercent === null ? '' : String(s.commissionPercent),
    'number',
    'Leave empty for the default',
  );
  if (v === null) return;
  const r = await guard(
    () => adminMarketApi.updateSeller(s.id, { commissionPercent: v === '' ? null : Number(v) }),
    'Commission updated',
  );
  if (r) Object.assign(s, r);
}

async function toggleSeller(s: MktSellerAdminDto) {
  const r = await guard(() =>
    adminMarketApi.updateSeller(s.id, { status: s.status === 'active' ? 'suspended' : 'active' }),
  );
  if (r) Object.assign(s, r);
}

async function editCategory(id: number | null, name: string, parentId: number | null) {
  const v = await ask(id ? 'Rename category' : parentId ? 'New subcategory' : 'New category', name, 'text');
  if (!v) return;
  const r = await guard(() => adminMarketApi.saveCategory(id, id ? { name: v } : { name: v, parentId }));
  if (r) categories.value = r;
}

async function removeCategory(id: number) {
  const r = await guard(() => adminMarketApi.deleteCategory(id), 'Category deleted');
  if (r) categories.value = r;
}

onMounted(load);
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
  font-size: 13px;
}
.child {
  --padding-start: 32px;
}
</style>
