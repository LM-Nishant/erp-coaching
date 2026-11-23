<template>
  <AppPage
    :title="platform ? 'Platform coupons' : 'Coupons'"
    :back-href="platform ? undefined : `/market/studio/${scope}`"
    :on-refresh="load"
  >
    <p class="muted">
      {{
        platform
          ? 'Platform coupons work on every course in the marketplace.'
          : 'Your coupons work on your own courses only. Share the code with learners.'
      }}
    </p>
    <ion-list>
      <ion-item v-for="c in coupons" :key="c.id">
        <ion-label>
          <h3>{{ c.code }}</h3>
          <p>
            {{ c.kind === 'percent' ? `${c.value}% off` : `${rupees(c.value)} off` }}
            · used {{ c.usedCount }}{{ c.maxUses ? ` of ${c.maxUses}` : '' }}
            <template v-if="c.validUntil">
              · until {{ new Date(c.validUntil).toLocaleDateString() }}</template
            >
          </p>
        </ion-label>
        <ion-toggle
          slot="end"
          :checked="c.active"
          aria-label="Active"
          @ion-change="toggle(c, $event.detail.checked)"
        />
        <ion-button slot="end" fill="clear" color="danger" aria-label="Delete coupon" @click="remove(c)">
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
    </ion-list>
    <p v-if="loaded && !coupons.length" class="muted">No coupons yet.</p>

    <h3>New coupon</h3>
    <form @submit.prevent="create">
      <ion-list>
        <ion-item>
          <ion-input
            v-model="form.code"
            label="Code"
            label-placement="stacked"
            autocapitalize="characters"
            required
          />
        </ion-item>
        <ion-item>
          <ion-select v-model="form.kind" label="Discount" label-placement="stacked" interface="popover">
            <ion-select-option value="percent">Percent off</ion-select-option>
            <ion-select-option value="amount">Rupees off</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.value"
            type="number"
            min="1"
            :label="form.kind === 'percent' ? 'Percent' : 'Rupees off each course'"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.maxUses"
            type="number"
            min="1"
            label="Use limit (optional)"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.validUntil"
            type="date"
            label="Valid until (optional)"
            label-placement="stacked"
          />
        </ion-item>
      </ion-list>
      <ion-button type="submit" expand="block" :disabled="busy || !form.code.trim() || !form.value"
        >Create coupon</ion-button
      >
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  alertController,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import type { MktCouponDto, MktCouponInput, MktCouponKind } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { adminMarketApi, rupees, studioApi, type StudioScope } from '../api';

const route = useRoute();
const platform = !!route.meta.superAdmin;
const scope = route.params.scope as StudioScope;
const api = computed(() => (platform ? adminMarketApi : studioApi(scope)));
const coupons = ref<MktCouponDto[]>([]);
const loaded = ref(false);
const busy = ref(false);
const form = reactive({
  code: '',
  kind: 'percent' as MktCouponKind,
  value: 10,
  maxUses: null as number | null,
  validUntil: '',
});

async function load() {
  try {
    coupons.value = await api.value.coupons();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function create() {
  busy.value = true;
  try {
    const input: MktCouponInput = {
      code: form.code.trim().toUpperCase(),
      kind: form.kind,
      value: form.kind === 'percent' ? Number(form.value) : Math.round(Number(form.value) * 100),
      maxUses: form.maxUses || null,
      validUntil: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).toISOString() : null,
    };
    await api.value.createCoupon(input);
    form.code = '';
    await load();
    await toast('Coupon created');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function toggle(c: MktCouponDto, active: boolean) {
  try {
    await api.value.updateCoupon(c.id, { active });
    c.active = active;
  } catch (e) {
    void toastError(e);
  }
}

async function remove(c: MktCouponDto) {
  const alert = await alertController.create({
    header: `Delete ${c.code}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await api.value.deleteCoupon(c.id);
    await load();
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
}
</style>
