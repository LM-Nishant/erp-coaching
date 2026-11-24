<template>
  <section class="audience-picker">
    <h3 class="heading">{{ t('notifications.audience.sendTo') }}</h3>
    <div class="chips" role="radiogroup" :aria-label="t('notifications.audience.sendTo')">
      <button
        v-for="s in scopes"
        :key="s"
        type="button"
        role="radio"
        :aria-checked="model.scope === s"
        :class="['chip', 'big', { on: model.scope === s }]"
        @click="setScope(s)"
      >
        {{ t(`notifications.audience.scope.${s}`) }}
      </button>
    </div>

    <template v-if="model.scope === 'batches'">
      <ion-searchbar
        v-if="batches.length > 6"
        v-model="query"
        :placeholder="t('notifications.audience.findBatch')"
        class="find"
      />
      <ion-list class="batches" lines="full">
        <ion-item v-for="b in shownBatches" :key="b.id">
          <ion-checkbox
            :checked="model.batchIds.includes(b.id)"
            justify="start"
            label-placement="end"
            @ion-change="toggleBatch(b.id)"
          >
            {{ b.name }}
            <span v-if="b.enrolledCount !== undefined" class="muted">
              · {{ t('notifications.audience.students', { n: b.enrolledCount }, b.enrolledCount) }}</span
            >
          </ion-checkbox>
        </ion-item>
        <ion-item v-if="!shownBatches.length" lines="none">
          <ion-label class="muted">{{ t('notifications.audience.noBatches') }}</ion-label>
        </ion-item>
      </ion-list>
    </template>

    <h3 class="heading">{{ t('notifications.audience.whoTitle') }}</h3>
    <div class="chips">
      <button
        v-for="w in whoOptions"
        :key="w"
        type="button"
        :aria-pressed="model.who.includes(w)"
        :class="['chip', { on: model.who.includes(w) }]"
        @click="toggleWho(w)"
      >
        {{ t(`notifications.audience.who.${w}`) }}
      </button>
    </div>

    <template v-if="model.scope === 'institute' && branches.length > 1">
      <h3 class="heading">{{ t('notifications.audience.branch') }}</h3>
      <p v-if="branchLimited" class="muted">{{ branchName(model.branchId) }}</p>
      <div v-else class="chips">
        <button
          type="button"
          :aria-pressed="model.branchId === null"
          :class="['chip', { on: model.branchId === null }]"
          @click="model.branchId = null"
        >
          {{ t('notifications.audience.allBranches') }}
        </button>
        <button
          v-for="b in branches"
          :key="b.id"
          type="button"
          :aria-pressed="model.branchId === b.id"
          :class="['chip', { on: model.branchId === b.id }]"
          @click="model.branchId = b.id"
        >
          {{ b.name }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonCheckbox, IonItem, IonLabel, IonList, IonSearchbar } from '@ionic/vue';
import type { BatchDto } from '@erp/shared';
import { useAuthStore } from '@/stores/auth';
import { AUDIENCE_WHO, type AudienceChoice, type AudienceWho } from '../audience';

/**
 * "Who gets this message": whole institute or chosen batches, then students / parents / teachers (and
 * staff for the whole institute), then the branch. Replaces typing role slugs and batch ids.
 */
const props = defineProps<{ batches: BatchDto[] }>();
const model = defineModel<AudienceChoice>({ required: true });
const { t } = useI18n();
const auth = useAuthStore();
const query = ref('');

const branches = computed(() => auth.me?.branches ?? []);
const branchLimited = computed(() => !!auth.me?.allowedBranchIds);
const scopes = computed(() =>
  props.batches.length ? (['institute', 'batches'] as const) : (['institute'] as const),
);
const whoOptions = computed(() =>
  model.value.scope === 'batches' ? AUDIENCE_WHO.filter((w) => w !== 'staff') : AUDIENCE_WHO,
);
const shownBatches = computed(() => {
  const limited = auth.me?.allowedBranchIds;
  const q = query.value.trim().toLowerCase();
  return props.batches.filter(
    (b) =>
      (!limited || limited.includes(b.branchId)) &&
      (!q || b.name.toLowerCase().includes(q) || b.code.toLowerCase().includes(q)),
  );
});

const branchName = (id: number | null) => branches.value.find((b) => b.id === id)?.name ?? '';

function setScope(s: AudienceChoice['scope']) {
  const m = model.value;
  m.scope = s;
  if (s === 'batches') {
    m.who = m.who.filter((w) => w !== 'staff');
    // A batch already belongs to a branch; only branch-limited senders still name theirs.
    if (!branchLimited.value) m.branchId = null;
  }
}

function toggleWho(w: AudienceWho) {
  const m = model.value;
  m.who = m.who.includes(w) ? m.who.filter((x) => x !== w) : [...m.who, w];
}

function toggleBatch(id: number) {
  const m = model.value;
  m.batchIds = m.batchIds.includes(id) ? m.batchIds.filter((x) => x !== id) : [...m.batchIds, id];
}
</script>

<style scoped>
.heading {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ion-color-medium-shade);
}
.heading:first-child {
  margin-top: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  min-height: var(--app-tap-target);
  padding: 0 16px;
  border: 1px solid var(--ion-color-step-200, #ccc);
  border-radius: 999px;
  background: var(--ion-item-background, #fff);
  color: var(--ion-text-color);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}
.chip.big {
  flex: 1;
  font-weight: 600;
}
.chip.on {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary);
  font-weight: 600;
}
.batches {
  max-height: 280px;
  overflow: auto;
  margin-top: 8px;
}
.find {
  padding: 8px 0 0;
}
.muted {
  color: var(--ion-color-medium);
}
</style>
