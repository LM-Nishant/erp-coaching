<template>
  <AppPage title="Roles & permissions" :on-refresh="load">
    <template #actions>
      <ion-button v-if="tab === 'roles'" v-can="'roles.create'" @click="openNew">
        <ion-icon slot="start" :icon="addOutline" />Create role
      </ion-button>
      <ion-button v-else v-can="'users.create'" @click="editing = 'new'">
        <ion-icon slot="start" :icon="personAddOutline" />Add staff
      </ion-button>
    </template>

    <ion-segment v-if="auth.can('users.view')" v-model="tab" @ion-change="tabChanged">
      <ion-segment-button value="roles"><ion-label>Roles</ion-label></ion-segment-button>
      <ion-segment-button value="staff"><ion-label>Staff access</ion-label></ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'roles'">
      <p class="muted ion-padding-horizontal">
        A role is a set of permissions. System roles come with the ERP; create custom roles for the jobs in
        your institute, then give them to staff under Staff access.
      </p>
      <ion-list v-for="group in groups" :key="group.title">
        <ion-list-header
          ><ion-label>{{ group.title }}</ion-label></ion-list-header
        >
        <ion-item v-for="r in group.roles" :key="r.id" button detail @click="openRole(r)">
          <ion-icon
            slot="start"
            :icon="r.isSystem ? lockClosedOutline : shieldCheckmarkOutline"
            :color="r.isSystem ? 'medium' : 'primary'"
            aria-hidden="true"
          />
          <ion-label class="ion-text-wrap">
            <h2>{{ r.name }}</h2>
            <p>{{ r.description || 'No description' }}</p>
            <p class="muted">{{ countLabel(r.permissions.length, 'permission') }}</p>
          </ion-label>
          <ion-note slot="end">{{ countLabel(r.memberCount, 'member') }}</ion-note>
        </ion-item>
        <ion-item v-if="!group.roles.length" lines="none">
          <ion-label class="muted ion-text-wrap">{{ group.empty }}</ion-label>
        </ion-item>
      </ion-list>
    </template>

    <template v-else>
      <ion-searchbar
        v-model="search"
        :debounce="300"
        placeholder="Name, mobile or email"
        @ion-input="loadStaff"
      />
      <ion-list>
        <ion-item
          v-for="m in staff"
          :key="m.id"
          :button="auth.can('users.edit')"
          :detail="auth.can('users.edit')"
          @click="auth.can('users.edit') && (editing = m)"
        >
          <ion-label class="ion-text-wrap">
            <h2>
              {{ m.name }}
              <ion-badge v-if="m.status !== 'active'" color="medium">{{ m.status }}</ion-badge>
            </h2>
            <p>{{ describeAssignments(m.roles, branchName) }}</p>
            <p class="muted">{{ m.mobile }}</p>
          </ion-label>
        </ion-item>
        <ion-item v-if="staffLoaded && !staff.length"
          ><ion-label class="muted">No staff found.</ion-label></ion-item
        >
      </ion-list>
    </template>

    <RoleEditorModal
      :draft="draft"
      :catalog="catalog"
      :can-create="auth.can('roles.create')"
      :can-edit="auth.can('roles.edit')"
      :can-delete="auth.can('roles.delete')"
      @close="draft = null"
      @saved="roleSaved"
      @duplicate="duplicate"
      @delete="remove"
    />
    <MemberRolesModal
      :member="editing"
      :roles="roles"
      :branches="branches"
      :can-grant-institute-wide="!auth.me || auth.me.allowedBranchIds === null"
      :self-id="auth.me?.user.id ?? null"
      @close="editing = null"
      @saved="memberSaved"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  alertController,
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import { addOutline, lockClosedOutline, personAddOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import type { PermissionCatalogEntry, RoleDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { api, ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import MemberRolesModal from './MemberRolesModal.vue';
import RoleEditorModal, { type RoleDraft } from './RoleEditorModal.vue';
import { type MemberSummary, copyName, defaultPermissions, describeAssignments, rolesApi } from './api';

const auth = useAuthStore();
const tab = ref<'roles' | 'staff'>('roles');
const roles = ref<RoleDto[]>([]);
const catalog = ref<PermissionCatalogEntry[]>([]);
const branches = ref<{ id: number; name: string }[]>([]);
const draft = ref<RoleDraft | null>(null);
const staff = ref<MemberSummary[]>([]);
const staffLoaded = ref(false);
const search = ref('');
const editing = ref<MemberSummary | 'new' | null>(null);

const groups = computed(() => [
  {
    title: 'Custom roles',
    roles: roles.value.filter((r) => !r.isSystem),
    empty: 'No custom roles yet. Create one, or open a system role and duplicate it.',
  },
  { title: 'System roles', roles: roles.value.filter((r) => r.isSystem), empty: '' },
]);
const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name;
const countLabel = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function load() {
  try {
    const [list, permissions, branchList] = await Promise.all([
      rolesApi.list(),
      catalog.value.length ? Promise.resolve(catalog.value) : rolesApi.catalog(),
      auth.can('branches.view') ? api.get<{ id: number; name: string }[]>('/branches') : Promise.resolve([]),
    ]);
    roles.value = list;
    catalog.value = permissions;
    branches.value = branchList;
    if (tab.value === 'staff') await loadStaff();
  } catch (e) {
    await toastError(e);
  }
}

async function loadStaff() {
  try {
    staff.value = (await rolesApi.staff(search.value.trim())).items;
    staffLoaded.value = true;
  } catch (e) {
    await toastError(e);
  }
}

function tabChanged() {
  if (tab.value === 'staff' && !staffLoaded.value) void loadStaff();
}

function openNew() {
  draft.value = { name: '', description: '', permissions: defaultPermissions(catalog.value) };
}

function openRole(role: RoleDto) {
  draft.value = {
    role,
    name: role.name,
    description: role.description ?? '',
    permissions: [...role.permissions],
  };
}

function duplicate(role: RoleDto) {
  draft.value = {
    name: copyName(
      role.name,
      roles.value.map((r) => r.name),
    ),
    description: role.description ?? '',
    permissions: [...role.permissions],
  };
}

async function roleSaved() {
  draft.value = null;
  await load();
  // Editing a role the signed-in user holds changes their own menu.
  await auth.fetchMe().catch(() => undefined);
}

async function memberSaved() {
  editing.value = null;
  await Promise.all([loadStaff(), load()]);
}

async function remove(role: RoleDto) {
  if (role.memberCount > 0) {
    const alert = await alertController.create({
      header: `${role.name} is in use`,
      message: `${countLabel(role.memberCount, 'staff member')} ${role.memberCount === 1 ? 'holds' : 'hold'} this role. Give them another role under Staff access, then delete it.`,
      buttons: ['OK'],
    });
    return alert.present();
  }
  const alert = await alertController.create({
    header: `Delete ${role.name}?`,
    message: 'This cannot be undone.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () =>
          rolesApi
            .remove(role.id)
            .then(async () => {
              draft.value = null;
              await toast(`${role.name} deleted`);
              await load();
            })
            .catch((e) =>
              toastError(
                e instanceof ApiError && e.code === 'ROLE_IN_USE'
                  ? new Error(`${role.name} is held by staff members; give them another role first.`)
                  : e,
              ),
            ),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
