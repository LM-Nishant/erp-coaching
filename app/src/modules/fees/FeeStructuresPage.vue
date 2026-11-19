<template>
  <AppPage title="Fee structures" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'fees.create'" aria-label="New fee structure" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-segment v-model="status" @ion-change="load">
      <ion-segment-button value="active">Active</ion-segment-button>
      <ion-segment-button value="draft">Draft</ion-segment-button>
      <ion-segment-button value="archived">History</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item v-for="s in structures" :key="s.id" button @click="openEditor(s)">
        <ion-label>
          <h3>
            {{ s.name }} <small class="muted">v{{ s.version }}</small>
          </h3>
          <p>
            {{ s.kind === 'subject' ? 'Subject purchase' : 'Course' }} · {{ courseName(s.courseId)
            }}<span v-if="s.batchId"> · batch #{{ s.batchId }}</span> ·
            {{ s.instalmentPlan.type.replace('_', ' ') }}
            <span v-if="s.instalmentPlan.count">× {{ s.instalmentPlan.count }}</span>
          </p>
          <p class="muted">Effective {{ s.effectiveFrom }} · {{ s.components.length }} component(s)</p>
        </ion-label>
        <ion-note slot="end">{{ rupees(s.total) }}</ion-note>
      </ion-item>
      <ion-item v-if="!structures.length"><ion-label class="muted">No fee structures.</ion-label></ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ form?.id ? `New version of ${form.name}` : 'New fee structure' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <p v-if="form.id" class="muted">
            Saving creates version {{ (form.version ?? 0) + 1 }}; earlier versions stay attached to existing
            accounts.
          </p>
          <ion-list>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <template v-if="!form.id">
              <ion-item>
                <ion-select v-model="form.kind" label="Type" label-placement="stacked">
                  <ion-select-option value="course">Course fee</ion-select-option>
                  <ion-select-option value="subject">Subject purchase</ion-select-option>
                </ion-select>
              </ion-item>
              <ion-item>
                <ion-select v-model="form.courseId" label="Course" label-placement="stacked">
                  <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{
                    c.name
                  }}</ion-select-option>
                </ion-select>
              </ion-item>
              <ion-item>
                <ion-select v-model="form.batchId" label="Batch (optional)" label-placement="stacked">
                  <ion-select-option :value="null">All batches</ion-select-option>
                  <ion-select-option
                    v-for="b in batches.filter((x) => !form?.courseId || x.courseId === form.courseId)"
                    :key="b.id"
                    :value="b.id"
                    >{{ b.name }}</ion-select-option
                  >
                </ion-select>
              </ion-item>
              <ion-item v-if="form.kind === 'subject'">
                <ion-input
                  v-model.number="form.subjectId"
                  type="number"
                  label="Subject id"
                  label-placement="stacked"
                />
              </ion-item>
            </template>
            <ion-item>
              <ion-input
                v-model="form.effectiveFrom"
                type="date"
                label="Effective from"
                label-placement="stacked"
              />
            </ion-item>
            <ion-list-header>Components</ion-list-header>
            <ion-item v-for="(c, i) in form.components" :key="i">
              <ion-select v-model="c.feeHeadId" placeholder="Fee head" interface="popover">
                <ion-select-option v-for="h in heads" :key="h.id" :value="h.id">{{
                  h.name
                }}</ion-select-option>
              </ion-select>
              <ion-input v-model="c.amount" type="number" placeholder="₹" />
              <ion-button slot="end" fill="clear" color="danger" @click="form.components.splice(i, 1)"
                >✕</ion-button
              >
            </ion-item>
            <ion-button
              fill="clear"
              size="small"
              @click="form.components.push({ feeHeadId: null, amount: '' })"
              >Add component</ion-button
            >
            <p class="muted">Total {{ rupees(total) }}</p>
            <ion-list-header>Instalment plan</ion-list-header>
            <ion-item>
              <ion-select v-model="form.planType" label="Plan" label-placement="stacked">
                <ion-select-option v-for="t in INSTALMENT_PLAN_TYPES" :key="t" :value="t">{{
                  t.replace('_', ' ')
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <template v-if="form.planType === 'custom'">
              <ion-item v-for="(c, i) in form.custom" :key="i">
                <ion-input v-model="c.label" placeholder="Label" />
                <ion-input v-model="c.dueDate" type="date" />
                <ion-input v-model.number="c.percent" type="number" placeholder="%" />
                <ion-button slot="end" fill="clear" color="danger" @click="form.custom.splice(i, 1)"
                  >✕</ion-button
                >
              </ion-item>
              <ion-button
                fill="clear"
                size="small"
                @click="
                  form.custom.push({
                    label: `Instalment ${form.custom.length + 1}`,
                    dueDate: todayIso(),
                    percent: 0,
                  })
                "
                >Add instalment</ion-button
              >
            </template>
            <template v-else>
              <ion-item v-if="form.planType !== 'one_time'">
                <ion-input
                  v-model.number="form.count"
                  type="number"
                  label="Number of instalments"
                  label-placement="stacked"
                />
              </ion-item>
              <ion-item>
                <ion-input
                  v-model="form.firstDueDate"
                  type="date"
                  label="First due date"
                  label-placement="stacked"
                />
              </ion-item>
            </template>
          </ion-list>
          <ion-button v-can="'fees.create'" expand="block" type="submit" :disabled="saving">{{
            form.id ? 'Save new version' : 'Create structure'
          }}</ion-button>
          <ion-button
            v-if="form.id"
            v-can="'fees.edit'"
            expand="block"
            fill="outline"
            color="medium"
            @click="archive"
            >Archive</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import {
  INSTALMENT_PLAN_TYPES,
  type BatchDto,
  type CourseDto,
  type CustomInstalment,
  type FeeHeadDto,
  type FeeStructureDto,
  type InstalmentPlanType,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { academicsApi } from '../academics/api';
import { rupees, todayIso } from '../hr/api';
import { feesApi, toPaise } from './api';

interface Form {
  id?: number;
  version?: number;
  name: string;
  kind: 'course' | 'subject';
  courseId: number | null;
  batchId: number | null;
  subjectId: number | null;
  effectiveFrom: string;
  components: { feeHeadId: number | null; amount: string }[];
  planType: InstalmentPlanType;
  count: number;
  firstDueDate: string;
  custom: CustomInstalment[];
}

const status = ref<'active' | 'draft' | 'archived'>('active');
const structures = ref<FeeStructureDto[]>([]);
const heads = ref<FeeHeadDto[]>([]);
const courses = ref<CourseDto[]>([]);
const batches = ref<BatchDto[]>([]);
const form = ref<Form | null>(null);
const saving = ref(false);
const total = computed(() => (form.value?.components ?? []).reduce((s, c) => s + toPaise(c.amount || 0), 0));
const courseName = (id: number | null) => courses.value.find((c) => c.id === id)?.name ?? 'Any course';

async function load() {
  try {
    const [s, h, c, b] = await Promise.all([
      feesApi.structures({ status: status.value }),
      feesApi.heads(),
      academicsApi.courses(),
      academicsApi.batches(),
    ]);
    structures.value = s.items;
    heads.value = h.filter((x) => x.active);
    courses.value = c.items;
    batches.value = b.items;
  } catch (e) {
    void toastError(e);
  }
}

function openEditor(s?: FeeStructureDto) {
  form.value = {
    id: s?.id,
    version: s?.version,
    name: s?.name ?? '',
    kind: s?.kind ?? 'course',
    courseId: s?.courseId ?? null,
    batchId: s?.batchId ?? null,
    subjectId: s?.subjectId ?? null,
    effectiveFrom: todayIso(),
    components: s?.components.map((c) => ({ feeHeadId: c.feeHeadId, amount: String(c.amount / 100) })) ?? [
      { feeHeadId: heads.value[0]?.id ?? null, amount: '' },
    ],
    planType: s?.instalmentPlan.type ?? 'one_time',
    count: s?.instalmentPlan.count ?? 1,
    firstDueDate: s?.instalmentPlan.firstDueDate ?? todayIso(),
    custom: s?.instalmentPlan.custom ? s.instalmentPlan.custom.map((c) => ({ ...c })) : [],
  };
}

async function save() {
  const f = form.value;
  if (!f) return;
  const instalmentPlan =
    f.planType === 'custom'
      ? { type: f.planType, custom: f.custom }
      : { type: f.planType, count: f.planType === 'one_time' ? 1 : f.count, firstDueDate: f.firstDueDate };
  const body = {
    name: f.name,
    effectiveFrom: f.effectiveFrom,
    components: f.components
      .filter((c) => c.amount !== '')
      .map((c) => ({ feeHeadId: c.feeHeadId, amount: toPaise(c.amount) })),
    instalmentPlan,
  };
  saving.value = true;
  try {
    if (f.id) await feesApi.newVersion(f.id, body);
    else
      await feesApi.createStructure({
        ...body,
        kind: f.kind,
        courseId: f.courseId,
        batchId: f.batchId,
        subjectId: f.kind === 'subject' ? f.subjectId : null,
        status: 'active',
      });
    await toast('Fee structure saved');
    form.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

async function archive() {
  if (!form.value?.id) return;
  try {
    await feesApi.updateStructure(form.value.id, { status: 'archived' });
    form.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>
