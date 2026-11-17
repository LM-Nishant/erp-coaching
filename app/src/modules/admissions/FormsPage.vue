<template>
  <AppPage title="Admission forms" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'admissions.configure'" @click="open()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <p class="muted ion-padding-horizontal">
      Custom fields are added to the enquiry, admission and self-registration forms. A branch-specific active
      form overrides the institute-wide one.
    </p>
    <ion-list>
      <ion-item v-for="f in forms" :key="f.id" button detail @click="open(f)">
        <ion-label>
          <h2>
            {{ f.name }}
            <ion-badge :color="f.isActive ? 'success' : 'medium'">{{
              f.isActive ? 'active' : 'inactive'
            }}</ion-badge>
          </h2>
          <p>
            {{ humanize(f.purpose) }} · {{ f.branchId ? branchName(f.branchId) : 'All branches' }} ·
            {{ f.fields.length }} fields
          </p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!forms.length"><ion-label class="muted">No custom forms yet.</ion-label></ion-item>
    </ion-list>

    <ion-modal :is-open="!!edit" @did-dismiss="edit = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>{{ edit?.id ? 'Edit form' : 'New form' }}</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="edit = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="edit" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="edit.name" label="Form name *" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="edit.description" label="Description" label-placement="stacked"
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="edit.purpose"
                label="Used for"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option value="enquiry">Enquiry</ion-select-option>
                <ion-select-option value="admission">Admission application</ion-select-option>
                <ion-select-option value="self_registration">Student self-registration</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="edit.branchId"
                label="Branch"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option :value="null">All branches</ion-select-option>
                <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item><ion-toggle v-model="edit.isActive">Active</ion-toggle></ion-item>
          </ion-list>

          <h3>Fields</h3>
          <ion-card v-for="(fld, i) in edit.fields" :key="i">
            <ion-card-content>
              <ion-item
                ><ion-input
                  v-model="fld.label"
                  label="Label *"
                  label-placement="stacked"
                  required
                  @ion-blur="autoKey(fld)"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="fld.key"
                  label="Key (snake_case) *"
                  label-placement="stacked"
                  required
                  pattern="[a-z][a-z0-9_]*"
              /></ion-item>
              <ion-item>
                <ion-select v-model="fld.type" label="Type" label-placement="stacked" interface="popover">
                  <ion-select-option v-for="t in FORM_FIELD_TYPES" :key="t" :value="t">{{
                    humanize(t)
                  }}</ion-select-option>
                </ion-select>
              </ion-item>
              <ion-item v-if="fld.type === 'select'">
                <ion-input
                  v-model="fld.optionsText"
                  label="Options (comma separated) *"
                  label-placement="stacked"
                  required
                />
              </ion-item>
              <ion-item
                ><ion-input v-model="fld.helpText" label="Help text" label-placement="stacked"
              /></ion-item>
              <ion-item><ion-checkbox v-model="fld.required">Required</ion-checkbox></ion-item>
              <ion-button size="small" fill="clear" :disabled="i === 0" @click="moveField(i, -1)"
                ><ion-icon slot="icon-only" :icon="arrowUp"
              /></ion-button>
              <ion-button
                size="small"
                fill="clear"
                :disabled="i === edit.fields.length - 1"
                @click="moveField(i, 1)"
                ><ion-icon slot="icon-only" :icon="arrowDown"
              /></ion-button>
              <ion-button size="small" fill="clear" color="danger" @click="edit.fields.splice(i, 1)"
                ><ion-icon slot="icon-only" :icon="trashOutline"
              /></ion-button>
            </ion-card-content>
          </ion-card>
          <ion-button fill="outline" expand="block" @click="addField"
            ><ion-icon slot="start" :icon="add" />Add field</ion-button
          >

          <ion-button expand="block" type="submit" :disabled="saving">Save form</ion-button>
          <ion-button v-if="edit.id" expand="block" fill="clear" color="danger" @click="remove"
            >Delete form</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, arrowDown, arrowUp, trashOutline } from 'ionicons/icons';
import {
  FORM_FIELD_TYPES,
  type AdmissionFormDto,
  type AdmissionFormPurpose,
  type FormFieldDef,
  type FormFieldType,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { branchesApi, type Branch } from '@/modules/branches/api';
import { humanize } from '@/modules/students/api';
import { admissionsApi } from './api';

interface EditField {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  optionsText: string;
  helpText: string;
}
interface EditForm {
  id: number | null;
  name: string;
  description: string;
  purpose: AdmissionFormPurpose;
  branchId: number | null;
  isActive: boolean;
  fields: EditField[];
}

const forms = ref<AdmissionFormDto[]>([]);
const branches = ref<Branch[]>([]);
const edit = ref<EditForm | null>(null);
const saving = ref(false);

const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name ?? `Branch #${id}`;

async function load() {
  try {
    forms.value = await admissionsApi.forms();
  } catch (e) {
    await toastError(e);
  }
}

function open(f?: AdmissionFormDto) {
  edit.value = f
    ? {
        id: f.id,
        name: f.name,
        description: f.description ?? '',
        purpose: f.purpose,
        branchId: f.branchId,
        isActive: f.isActive,
        fields: f.fields.map((x) => ({
          key: x.key,
          label: x.label,
          type: x.type,
          required: !!x.required,
          optionsText: (x.options ?? []).join(', '),
          helpText: x.helpText ?? '',
        })),
      }
    : {
        id: null,
        name: '',
        description: '',
        purpose: 'admission',
        branchId: null,
        isActive: true,
        fields: [],
      };
}

const addField = () =>
  edit.value!.fields.push({
    key: '',
    label: '',
    type: 'text',
    required: false,
    optionsText: '',
    helpText: '',
  });

function autoKey(f: EditField) {
  if (!f.key && f.label)
    f.key = f.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^[^a-z]+|_+$/g, '')
      .slice(0, 40);
}

function moveField(i: number, dir: -1 | 1) {
  const fs = edit.value!.fields;
  [fs[i], fs[i + dir]] = [fs[i + dir]!, fs[i]!];
}

async function save() {
  const e = edit.value!;
  const fields: FormFieldDef[] = e.fields.map((f) => ({
    key: f.key.trim(),
    label: f.label.trim(),
    type: f.type,
    required: f.required,
    ...(f.type === 'select'
      ? {
          options: f.optionsText
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
        }
      : {}),
    ...(f.helpText.trim() ? { helpText: f.helpText.trim() } : {}),
  }));
  const body = {
    name: e.name.trim(),
    description: e.description.trim() || null,
    purpose: e.purpose,
    branchId: e.branchId,
    isActive: e.isActive,
    fields,
  };
  saving.value = true;
  try {
    if (e.id) await admissionsApi.updateForm(e.id, body);
    else await admissionsApi.createForm(body);
    edit.value = null;
    await toast('Form saved');
    await load();
  } catch (err) {
    await toastError(err);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const a = await alertController.create({
    header: 'Delete form?',
    message: 'Forms with submitted applications are deactivated instead.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  try {
    await admissionsApi.removeForm(edit.value!.id!);
    edit.value = null;
    await toast('Deleted');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
</script>
