<template>
  <ion-modal :is-open="open" class="member-roles" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ isNew ? 'Add staff member' : member?.name }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content v-if="open" class="ion-padding">
      <template v-if="isNew">
        <ion-list>
          <ion-item
            ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
          /></ion-item>
          <ion-item>
            <ion-input v-model="form.mobile" label="Mobile" label-placement="stacked" type="tel" required />
          </ion-item>
          <ion-item>
            <ion-input v-model="form.email" label="Email (optional)" label-placement="stacked" type="email" />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.password"
              label="Password (optional)"
              label-placement="stacked"
              type="password"
              helper-text="Leave empty to have them sign in with a mobile OTP"
            />
          </ion-item>
        </ion-list>
      </template>
      <p v-else class="muted">{{ [member?.mobile, member?.email].filter(Boolean).join(' · ') }}</p>
      <p v-if="isSelf" class="muted">You cannot change your own roles. Ask another Institute Admin.</p>

      <h2 class="heading">Roles</h2>
      <p class="muted">
        A role can apply to every branch or to one branch only. Permissions add up across roles.
      </p>
      <ion-list>
        <ion-item v-for="(row, i) in rows" :key="i">
          <div class="row">
            <ion-select
              v-model="row.roleId"
              class="role-select"
              label="Role"
              label-placement="stacked"
              interface="popover"
              placeholder="Choose a role"
              :disabled="isSelf"
            >
              <ion-select-option v-for="r in roleOptions(row.roleId)" :key="r.id" :value="r.id">{{
                r.name
              }}</ion-select-option>
            </ion-select>
            <ion-select
              v-model="row.branch"
              class="branch-select"
              label="Branches"
              label-placement="stacked"
              interface="popover"
              :disabled="isSelf"
            >
              <ion-select-option v-if="canGrantInstituteWide" :value="ALL">All branches</ion-select-option>
              <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </div>
          <ion-button
            v-if="!isSelf && rows.length > 1"
            slot="end"
            fill="clear"
            color="medium"
            :aria-label="`Remove role ${i + 1}`"
            @click="rows.splice(i, 1)"
            ><ion-icon slot="icon-only" :icon="closeOutline"
          /></ion-button>
        </ion-item>
      </ion-list>
      <ion-button v-if="!isSelf" fill="clear" size="small" @click="addRow">
        <ion-icon slot="start" :icon="addOutline" />Add another role
      </ion-button>
    </ion-content>
    <ion-footer v-if="open && !isSelf">
      <ion-toolbar>
        <ion-buttons slot="end">
          <ion-button @click="emit('close')">Cancel</ion-button>
          <ion-button fill="solid" color="primary" :disabled="busy || !ready" @click="save">Save</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-footer>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { addOutline, closeOutline } from 'ionicons/icons';
import type { RoleDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { PERSONA_ROLES, type MemberDetail, type MemberSummary, assignmentBody, rolesApi } from './api';

/** `member` = edit that member's roles; `'new'` = add a staff member; `null` = closed. */
const props = defineProps<{
  member: MemberSummary | 'new' | null;
  roles: RoleDto[];
  branches: { id: number; name: string }[];
  /** Branch-restricted users (branch admins) can only grant roles for their own branches. */
  canGrantInstituteWide: boolean;
  selfId: number | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const open = computed(() => props.member !== null);
const isNew = computed(() => props.member === 'new');
const member = computed(() => (props.member && props.member !== 'new' ? props.member : null));
const isSelf = computed(() => !!member.value && member.value.id === props.selfId);

const form = reactive({ name: '', mobile: '', email: '', password: '' });
/** `branch` is ALL (0) for every branch: ion-select cannot select a `null` option. */
const ALL = 0;
const rows = ref<{ roleId: number | null; branch: number }[]>([]);
const toRow = (r: { roleId: number; branchId: number | null }) => ({
  roleId: r.roleId,
  branch: r.branchId ?? ALL,
});
const assignments = () =>
  rows.value.map((r) => ({ roleId: r.roleId, branchId: r.branch === ALL ? null : r.branch }));
const detail = ref<MemberDetail | null>(null);
const busy = ref(false);

const addRow = () =>
  rows.value.push({
    roleId: null,
    branch: props.canGrantInstituteWide ? ALL : (props.branches[0]?.id ?? ALL),
  });

watch(
  () => props.member,
  async (m) => {
    detail.value = null;
    if (!m) return;
    if (m === 'new') {
      Object.assign(form, { name: '', mobile: '', email: '', password: '' });
      rows.value = [];
      addRow();
      return;
    }
    rows.value = m.roles.map(toRow);
    try {
      detail.value = await rolesApi.member(m.id);
      rows.value = detail.value.roles.map(toRow);
    } catch (e) {
      await toastError(e);
    }
  },
);

/** Staff roles, plus a persona role the member already holds (so saving keeps it). */
function roleOptions(current: number | null) {
  return props.roles.filter((r) => !PERSONA_ROLES.includes(r.slug) || r.id === current);
}

const ready = computed(
  () =>
    rows.value.some((r) => r.roleId !== null) &&
    (!isNew.value || (form.name.trim().length >= 2 && form.mobile.trim().length >= 10)) &&
    (isNew.value || !!detail.value),
);

async function save() {
  busy.value = true;
  try {
    if (isNew.value) {
      const body = assignmentBody(assignments(), []);
      await rolesApi.addMember({
        name: form.name.trim(),
        mobile: form.mobile.trim(),
        email: form.email.trim() || undefined,
        password: form.password || undefined,
        ...body,
      });
      await toast(`${form.name.trim()} added`);
    } else if (member.value && detail.value) {
      await rolesApi.setRoles(member.value.id, assignmentBody(assignments(), detail.value.branchIds));
      await toast(`Roles of ${member.value.name} saved`);
    }
    emit('saved');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.heading {
  font-size: 1rem;
  font-weight: 600;
  margin: 16px 0 0;
}
.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
}
@media (min-width: 768px) {
  ion-modal.member-roles {
    --width: 640px;
    --height: 85%;
  }
}
</style>
