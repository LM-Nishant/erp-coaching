<template>
  <div class="report-filters">
    <div class="fields">
      <ion-item v-if="allows('date')" class="field">
        <ion-select v-model="preset" label="Period" label-placement="stacked" interface="popover">
          <ion-select-option v-for="p in options.presets" :key="p.value" :value="p.value">{{
            p.label
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <template v-if="allows('date') && model.preset === 'custom'">
        <ion-item class="field"
          ><ion-input v-model="from" type="date" label="From" label-placement="stacked"
        /></ion-item>
        <ion-item class="field"
          ><ion-input v-model="to" type="date" label="To" label-placement="stacked"
        /></ion-item>
      </template>
      <ion-item v-if="showBranch" class="field">
        <ion-select v-model="branchId" label="Branch" label-placement="stacked" interface="popover">
          <ion-select-option :value="null">All branches</ion-select-option>
          <ion-select-option v-for="b in options.branches" :key="b.id" :value="b.id">{{
            b.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="showCourse" class="field">
        <ion-select v-model="courseId" label="Course" label-placement="stacked" interface="popover">
          <ion-select-option :value="null">All courses</ion-select-option>
          <ion-select-option v-for="c in options.courses" :key="c.id" :value="c.id">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="showBatch" class="field">
        <ion-select v-model="batchId" label="Batch" label-placement="stacked" interface="popover">
          <ion-select-option :value="null">All batches</ion-select-option>
          <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
    </div>
    <p v-if="rangeError" class="error">{{ rangeError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IonInput, IonItem, IonSelect, IonSelectOption } from '@ionic/vue';
import type { ReportDatePreset, ReportFilterKind, ReportFilterOptionsDto } from '@erp/shared';
import {
  batchChoices,
  customRangeError,
  isPersonalAudience,
  reconcileState,
  type ReportFilterState,
} from '../filters';

const props = withDefaults(
  defineProps<{
    options: ReportFilterOptionsDto;
    allowed?: readonly ReportFilterKind[];
    /** Period currently shown; a new custom range starts from it. */
    current?: { from: string; to: string } | null;
  }>(),
  { allowed: () => ['date', 'branch', 'course', 'batch'], current: null },
);
const model = defineModel<ReportFilterState>({ required: true });

const allows = (kind: ReportFilterKind) => props.allowed.includes(kind);
const personal = computed(() => isPersonalAudience(props.options.audience));
const batches = computed(() => batchChoices(props.options, model.value));
const showBranch = computed(() => !personal.value && allows('branch') && props.options.branches.length > 1);
const showCourse = computed(() => !personal.value && allows('course') && props.options.courses.length > 0);
const showBatch = computed(() => !personal.value && allows('batch') && batches.value.length > 0);
const rangeError = computed(() => customRangeError(model.value));

function update(patch: Partial<ReportFilterState>) {
  model.value = reconcileState({ ...model.value, ...patch }, props.options);
}

function field<K extends keyof ReportFilterState>(key: K) {
  return computed<ReportFilterState[K]>({
    get: () => model.value[key],
    set: (value) => update({ [key]: value } as Partial<ReportFilterState>),
  });
}

const preset = computed<ReportDatePreset>({
  get: () => model.value.preset,
  set: (value) => {
    // A new custom range starts from the period on screen (month to date as a fallback) so it can be adjusted.
    if (value === 'custom' && (!model.value.from || !model.value.to)) {
      const today = props.options.today;
      update({
        preset: value,
        from: props.current?.from ?? `${today.slice(0, 8)}01`,
        to: props.current?.to ?? today,
      });
    } else update({ preset: value });
  },
});
const from = field('from');
const to = field('to');
const branchId = field('branchId');
const courseId = field('courseId');
const batchId = field('batchId');
</script>

<style scoped>
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0 12px;
}
.error {
  color: var(--ion-color-danger);
  font-size: 13px;
  margin: 6px 0 0;
}
</style>
