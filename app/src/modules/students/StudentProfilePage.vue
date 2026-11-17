<template>
  <AppPage :title="student?.name ?? 'Student'" back-href="/students" :on-refresh="load">
    <template #actions>
      <ion-button v-if="student" v-can="'students.edit'" @click="openEdit"
        ><ion-icon slot="icon-only" :icon="createOutline"
      /></ion-button>
    </template>

    <template v-if="student">
      <ion-card>
        <ion-card-header>
          <ion-card-title>
            {{ student.name }}
            <ion-badge :color="STATUS_COLORS[student.status]">{{ student.status }}</ion-badge>
          </ion-card-title>
          <ion-card-subtitle>
            {{ student.admissionNumber
            }}<span v-if="student.rollNumber"> · Roll {{ student.rollNumber }}</span> ·
            {{ branchName(student.branchId) }}
          </ion-card-subtitle>
        </ion-card-header>
        <ion-card-content>
          <p>
            📱 {{ student.mobile }}<span v-if="student.email"> · ✉️ {{ student.email }}</span>
          </p>
          <p v-if="student.dateOfBirth">
            DOB {{ student.dateOfBirth }}<span v-if="student.gender"> · {{ student.gender }}</span>
          </p>
          <p v-if="student.address || student.city">
            {{ [student.address, student.city, student.state, student.pincode].filter(Boolean).join(', ') }}
          </p>
          <p v-if="student.idNumber">{{ student.idType ?? 'ID' }}: {{ student.idNumber }}</p>
          <p v-if="student.academicInfo">
            {{
              [
                student.academicInfo.schoolName,
                student.academicInfo.classGrade,
                student.academicInfo.board,
                student.academicInfo.targetExam,
              ]
                .filter(Boolean)
                .join(' · ')
            }}
          </p>
          <p v-for="(v, k) in student.customFields ?? {}" :key="k">{{ humanize(String(k)) }}: {{ v }}</p>
          <p v-if="student.statusReason" class="muted">Status reason: {{ student.statusReason }}</p>
          <p class="muted">Admitted {{ fmtDate(student.admittedAt) }} via {{ humanize(student.source) }}</p>
          <div v-can="'students.edit'">
            <ion-button size="small" fill="outline" @click="openStatus">Change status</ion-button>
            <ion-button v-if="branches.length > 1" size="small" fill="outline" @click="openTransfer"
              >Transfer branch</ion-button
            >
          </div>
        </ion-card-content>
      </ion-card>

      <ion-segment v-model="tab" scrollable>
        <ion-segment-button value="guardians"><ion-label>Guardians</ion-label></ion-segment-button>
        <ion-segment-button value="documents"><ion-label>Documents</ion-label></ion-segment-button>
        <ion-segment-button value="academics"><ion-label>Academic history</ion-label></ion-segment-button>
        <ion-segment-button value="history"><ion-label>Timeline</ion-label></ion-segment-button>
      </ion-segment>

      <ion-list v-if="tab === 'guardians'">
        <ion-item v-for="g in student.guardians" :key="g.linkId">
          <ion-label>
            <h2>
              {{ g.name }} <ion-badge v-if="g.isPrimary">primary</ion-badge>
              <ion-badge v-if="g.status !== 'active'" color="medium">{{ g.status }}</ion-badge>
            </h2>
            <p>
              {{ humanize(g.relation) }} · {{ g.mobile }}<span v-if="g.email"> · {{ g.email }}</span>
            </p>
          </ion-label>
          <ion-button
            v-if="g.status === 'pending'"
            slot="end"
            v-can="'guardians.edit'"
            fill="clear"
            @click="setLink(g, 'active')"
            >Approve</ion-button
          >
          <ion-button slot="end" v-can="'guardians.delete'" fill="clear" color="danger" @click="unlink(g)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item v-if="!student.guardians.length"
          ><ion-label class="muted">No guardians linked.</ion-label></ion-item
        >
        <ion-item v-can="'guardians.create'" button @click="openGuardian"
          ><ion-icon slot="start" :icon="add" /><ion-label>Link guardian</ion-label></ion-item
        >
      </ion-list>

      <ion-list v-if="tab === 'documents'">
        <ion-item v-for="d in student.documents" :key="d.id">
          <ion-label>
            <h2>
              <a :href="d.url" target="_blank" rel="noopener">{{ d.title || d.originalName }}</a>
            </h2>
            <p>{{ humanize(d.docType) }} · {{ fmtDate(d.createdAt) }}</p>
          </ion-label>
          <ion-button
            slot="end"
            v-can="'students.edit'"
            fill="clear"
            color="danger"
            @click="removeDocument(d.id)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item v-if="!student.documents.length"
          ><ion-label class="muted">No documents.</ion-label></ion-item
        >
        <div v-can="'students.edit'" class="ion-padding">
          <DocumentUpload :busy="uploading" @upload="uploadDocument" />
        </div>
      </ion-list>

      <ion-list v-if="tab === 'academics'">
        <ion-item v-for="r in student.academicRecords" :key="r.id">
          <ion-label>
            <h2>{{ [r.classGrade, r.institution].filter(Boolean).join(' · ') || 'Record' }}</h2>
            <p>
              {{
                [r.academicYear, r.board, r.result, r.percentage != null ? `${r.percentage}%` : null]
                  .filter(Boolean)
                  .join(' · ')
              }}
            </p>
            <p v-if="r.remarks">{{ r.remarks }}</p>
          </ion-label>
          <ion-button
            slot="end"
            v-can="'students.edit'"
            fill="clear"
            color="danger"
            @click="removeRecord(r.id)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item v-if="!student.academicRecords.length"
          ><ion-label class="muted">No academic records.</ion-label></ion-item
        >
        <ion-item v-can="'students.edit'" button @click="openRecord"
          ><ion-icon slot="start" :icon="add" /><ion-label>Add record</ion-label></ion-item
        >
      </ion-list>

      <ion-list v-if="tab === 'history'">
        <ion-item v-for="h in student.history" :key="h.id">
          <ion-label class="ion-text-wrap">
            <h2>{{ humanize(h.eventType) }}</h2>
            <p v-if="h.fromValue || h.toValue">{{ h.fromValue ?? '—' }} → {{ h.toValue ?? '—' }}</p>
            <p v-if="h.details?.reason">{{ h.details.reason }}</p>
            <p class="muted">{{ fmtDate(h.createdAt, true) }}</p>
          </ion-label>
        </ion-item>
      </ion-list>
    </template>

    <!-- Edit -->
    <ion-modal :is-open="!!edit" @did-dismiss="edit = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Edit student</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="edit = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="edit" @submit.prevent="saveEdit">
          <ion-list>
            <ion-item
              ><ion-input v-model="edit.name" label="Full name *" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="edit.mobile"
                label="Mobile *"
                label-placement="stacked"
                type="tel"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="edit.email" label="Email" label-placement="stacked" type="email"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="edit.dateOfBirth"
                label="Date of birth"
                label-placement="stacked"
                type="date"
            /></ion-item>
            <ion-item>
              <ion-select v-model="edit.gender" label="Gender" label-placement="stacked" interface="popover">
                <ion-select-option value="male">Male</ion-select-option>
                <ion-select-option value="female">Female</ion-select-option>
                <ion-select-option value="other">Other</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="edit.address" label="Address" label-placement="stacked"
            /></ion-item>
            <ion-item><ion-input v-model="edit.city" label="City" label-placement="stacked" /></ion-item>
            <ion-item><ion-input v-model="edit.state" label="State" label-placement="stacked" /></ion-item>
            <ion-item
              ><ion-input v-model="edit.pincode" label="Pincode" label-placement="stacked"
            /></ion-item>
            <ion-item><ion-input v-model="edit.idType" label="ID type" label-placement="stacked" /></ion-item>
            <ion-item
              ><ion-input v-model="edit.idNumber" label="ID number" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="edit.schoolName" label="School / college" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="edit.classGrade" label="Class / grade" label-placement="stacked"
            /></ion-item>
            <ion-item><ion-input v-model="edit.board" label="Board" label-placement="stacked" /></ion-item>
            <ion-item
              ><ion-input v-model="edit.targetExam" label="Target exam" label-placement="stacked"
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <!-- Status -->
    <ion-modal :is-open="!!statusForm" @did-dismiss="statusForm = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Change status</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="statusForm = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="statusForm" @submit.prevent="saveStatus">
          <ion-list>
            <ion-item>
              <ion-select
                v-model="statusForm.status"
                label="Status"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="s in STUDENT_STATUSES" :key="s" :value="s">{{
                  humanize(s)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-textarea v-model="statusForm.reason" label="Reason" label-placement="stacked" auto-grow
            /></ion-item>
          </ion-list>
          <p class="muted">
            Suspended, discontinued and inactive students lose access to the student portal.
          </p>
          <ion-button expand="block" type="submit" :disabled="busy">Update status</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <!-- Transfer -->
    <ion-modal :is-open="!!transferForm" @did-dismiss="transferForm = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Transfer branch</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="transferForm = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="transferForm" @submit.prevent="saveTransfer">
          <ion-list>
            <ion-item>
              <ion-select
                v-model="transferForm.branchId"
                label="New branch *"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option
                  v-for="b in branches.filter((x) => x.id !== student?.branchId)"
                  :key="b.id"
                  :value="b.id"
                  >{{ b.name }}</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-textarea v-model="transferForm.reason" label="Reason" label-placement="stacked" auto-grow
            /></ion-item>
            <ion-item
              ><ion-checkbox v-model="transferForm.regenerateRollNumber"
                >Generate a new roll number</ion-checkbox
              ></ion-item
            >
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy || !transferForm.branchId"
            >Transfer</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>

    <!-- Guardian -->
    <ion-modal :is-open="!!guardianForm" @did-dismiss="guardianForm = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Link guardian</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="guardianForm = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="guardianForm" @submit.prevent="saveGuardian">
          <ion-list>
            <ion-item
              ><ion-input v-model="guardianForm.name" label="Name *" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="guardianForm.mobile"
                label="Mobile *"
                label-placement="stacked"
                type="tel"
                required
            /></ion-item>
            <ion-item
              ><ion-input v-model="guardianForm.email" label="Email" label-placement="stacked" type="email"
            /></ion-item>
            <ion-item>
              <ion-select
                v-model="guardianForm.relation"
                label="Relation"
                label-placement="stacked"
                interface="popover"
              >
                <ion-select-option v-for="r in GUARDIAN_RELATIONS" :key="r" :value="r">{{
                  humanize(r)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="guardianForm.occupation" label="Occupation" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-checkbox v-model="guardianForm.isPrimary">Primary guardian</ion-checkbox></ion-item
            >
          </ion-list>
          <p class="muted">
            An existing parent account with this mobile is reused, so one guardian can be linked to several
            children. They sign in with mobile OTP.
          </p>
          <ion-button expand="block" type="submit" :disabled="busy">Link</ion-button>
        </form>
      </ion-content>
    </ion-modal>

    <!-- Academic record -->
    <ion-modal :is-open="!!recordForm" @did-dismiss="recordForm = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Academic record</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="recordForm = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content class="ion-padding">
        <form v-if="recordForm" @submit.prevent="saveRecord">
          <ion-list>
            <ion-item
              ><ion-input
                v-model="recordForm.academicYear"
                label="Academic year"
                label-placement="stacked"
                placeholder="2025-26"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="recordForm.institution"
                label="School / institution"
                label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="recordForm.classGrade" label="Class / grade" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="recordForm.board" label="Board" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="recordForm.result" label="Result" label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="recordForm.percentage"
                label="Percentage"
                label-placement="stacked"
                type="number"
            /></ion-item>
            <ion-item
              ><ion-textarea v-model="recordForm.remarks" label="Remarks" label-placement="stacked" auto-grow
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="busy">Add</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import {
  GUARDIAN_RELATIONS,
  STUDENT_STATUSES,
  type GuardianRelation,
  type StudentGuardianDto,
  type StudentProfileDto,
  type StudentStatus,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { branchesApi, type Branch } from '@/modules/branches/api';
import { STATUS_COLORS, fmtDate, humanize, studentsApi } from './api';
import DocumentUpload from './DocumentUpload.vue';

const route = useRoute();
const router = useRouter();
const id = Number(route.params.id);
const student = ref<StudentProfileDto | null>(null);
const branches = ref<Branch[]>([]);
const tab = ref<'guardians' | 'documents' | 'academics' | 'history'>('guardians');
const busy = ref(false);
const uploading = ref(false);

const branchName = (bid: number) => branches.value.find((b) => b.id === bid)?.name ?? `Branch #${bid}`;
const orNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

async function load() {
  try {
    student.value = await studentsApi.get(id);
  } catch (e) {
    await toastError(e);
    await router.replace('/students');
  }
}

async function run(fn: () => Promise<unknown>, done?: string) {
  busy.value = true;
  try {
    await fn();
    if (done) await toast(done);
    await load();
    return true;
  } catch (e) {
    await toastError(e);
    return false;
  } finally {
    busy.value = false;
  }
}

async function confirm(message: string) {
  const a = await alertController.create({
    header: 'Are you sure?',
    message,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'OK', role: 'confirm' },
    ],
  });
  await a.present();
  return (await a.onDidDismiss()).role === 'confirm';
}

// ---- edit
const edit = ref<Record<string, string | null> | null>(null);
function openEdit() {
  const s = student.value!;
  edit.value = {
    name: s.name,
    mobile: s.mobile,
    email: s.email,
    dateOfBirth: s.dateOfBirth,
    gender: s.gender,
    address: s.address,
    city: s.city,
    state: s.state,
    pincode: s.pincode,
    idType: s.idType,
    idNumber: s.idNumber,
    schoolName: s.academicInfo?.schoolName ?? null,
    classGrade: s.academicInfo?.classGrade ?? null,
    board: s.academicInfo?.board ?? null,
    targetExam: s.academicInfo?.targetExam ?? null,
  };
}
async function saveEdit() {
  const e = edit.value!;
  const ok = await run(
    () =>
      studentsApi.update(id, {
        name: e.name!.trim(),
        mobile: e.mobile!.trim(),
        email: orNull(e.email),
        dateOfBirth: orNull(e.dateOfBirth),
        gender: (e.gender as 'male' | 'female' | 'other' | null) ?? null,
        address: orNull(e.address),
        city: orNull(e.city),
        state: orNull(e.state),
        pincode: orNull(e.pincode),
        idType: orNull(e.idType),
        idNumber: orNull(e.idNumber),
        academicInfo: {
          ...student.value!.academicInfo,
          schoolName: orNull(e.schoolName),
          classGrade: orNull(e.classGrade),
          board: orNull(e.board),
          targetExam: orNull(e.targetExam),
        },
      }),
    'Saved',
  );
  if (ok) edit.value = null;
}

// ---- status
const statusForm = ref<{ status: StudentStatus; reason: string } | null>(null);
const openStatus = () => (statusForm.value = { status: student.value!.status, reason: '' });
async function saveStatus() {
  const f = statusForm.value!;
  if (await run(() => studentsApi.setStatus(id, f.status, orNull(f.reason)), 'Status updated'))
    statusForm.value = null;
}

// ---- transfer
const transferForm = ref<{ branchId: number | null; reason: string; regenerateRollNumber: boolean } | null>(
  null,
);
const openTransfer = () => (transferForm.value = { branchId: null, reason: '', regenerateRollNumber: true });
async function saveTransfer() {
  const f = transferForm.value!;
  const ok = await run(
    () =>
      studentsApi.transfer(id, {
        branchId: f.branchId!,
        reason: orNull(f.reason),
        regenerateRollNumber: f.regenerateRollNumber,
      }),
    'Transferred',
  );
  if (ok) transferForm.value = null;
}

// ---- guardians
const guardianForm = ref<{
  name: string;
  mobile: string;
  email: string;
  relation: GuardianRelation;
  occupation: string;
  isPrimary: boolean;
} | null>(null);
const openGuardian = () =>
  (guardianForm.value = {
    name: '',
    mobile: '',
    email: '',
    relation: 'father',
    occupation: '',
    isPrimary: !student.value!.guardians.some((g) => g.isPrimary),
  });
async function saveGuardian() {
  const f = guardianForm.value!;
  const ok = await run(
    () =>
      studentsApi.linkGuardian(id, {
        name: f.name.trim(),
        mobile: f.mobile.trim(),
        email: orNull(f.email),
        relation: f.relation,
        occupation: orNull(f.occupation),
        isPrimary: f.isPrimary,
      }),
    'Guardian linked',
  );
  if (ok) guardianForm.value = null;
}
const setLink = (g: StudentGuardianDto, status: 'active' | 'revoked') =>
  run(() => studentsApi.updateLink(id, g.linkId, { status }), 'Updated');
async function unlink(g: StudentGuardianDto) {
  if (await confirm(`Unlink ${g.name}? They will no longer see this student.`))
    await run(() => studentsApi.unlink(id, g.linkId), 'Unlinked');
}

// ---- documents
async function uploadDocument(p: { file: File; docType: string; title: string }) {
  uploading.value = true;
  try {
    await studentsApi.uploadDocument(id, p.file, p.docType, p.title || undefined);
    await toast('Uploaded');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
  }
}
async function removeDocument(docId: number) {
  if (await confirm('Delete this document?'))
    await run(() => studentsApi.removeDocument(id, docId), 'Deleted');
}

// ---- academic records
const recordForm = ref<Record<string, string> | null>(null);
const openRecord = () =>
  (recordForm.value = {
    academicYear: '',
    institution: '',
    classGrade: '',
    board: '',
    result: '',
    percentage: '',
    remarks: '',
  });
async function saveRecord() {
  const f = recordForm.value!;
  const ok = await run(
    () =>
      studentsApi.addRecord(id, {
        academicYear: orNull(f.academicYear),
        institution: orNull(f.institution),
        classGrade: orNull(f.classGrade),
        board: orNull(f.board),
        result: orNull(f.result),
        percentage: f.percentage !== '' && f.percentage != null ? Number(f.percentage) : null,
        remarks: orNull(f.remarks),
      }),
    'Added',
  );
  if (ok) recordForm.value = null;
}
async function removeRecord(recordId: number) {
  if (await confirm('Delete this record?'))
    await run(() => studentsApi.removeRecord(id, recordId), 'Deleted');
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
</script>
