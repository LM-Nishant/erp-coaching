<template>
  <ion-modal :is-open="!!draft" class="role-editor" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ title }}</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content v-if="draft" class="ion-padding">
      <p v-if="readOnly" class="muted">
        System roles come with the ERP and are the same in every institute, so their permissions cannot be
        changed. Duplicate one to start a custom role from it.
      </p>
      <ion-list class="fields">
        <ion-item>
          <ion-input
            v-model="name"
            label="Role name"
            label-placement="stacked"
            placeholder="e.g. Front desk, Auditor, Finance manager"
            :maxlength="100"
            :readonly="readOnly"
            required
          />
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="description"
            label="Description"
            label-placement="stacked"
            placeholder="What this role is for"
            :maxlength="255"
            :readonly="readOnly"
            auto-grow
          />
        </ion-item>
      </ion-list>

      <div class="permissions-head">
        <h2>Permissions</h2>
        <ion-note>{{ selected.length }} selected</ion-note>
      </div>
      <ion-searchbar v-model="filter" placeholder="Filter permissions" :debounce="150" />
      <p v-if="dropped.length" class="dropped" role="status">
        Custom roles cannot hold {{ dropped.map(labelOf).join(', ') }}; saving leaves
        {{ dropped.length === 1 ? 'it' : 'them' }} out.
      </p>

      <section
        v-for="section in visibleSections"
        :key="section.title"
        class="section"
        :class="{ locked: section.locked }"
      >
        <h3>{{ section.title }}</h3>
        <ul>
          <li v-for="p in section.permissions" :key="p.key">
            <ion-icon
              v-if="section.locked && !(readOnly && has(p.key))"
              class="lock-icon"
              :icon="removeCircleOutline"
              aria-hidden="true"
            />
            <ion-checkbox
              v-else
              :checked="has(p.key)"
              :disabled="readOnly || section.locked"
              label-placement="end"
              justify="start"
              :aria-label="`${p.label} — ${p.description}`"
              @ion-change="toggle(p.key, $event.detail.checked)"
            >
              <span class="perm"
                ><strong>{{ p.label }}</strong> — {{ p.description }}</span
              >
            </ion-checkbox>
            <span v-if="section.locked && !(readOnly && has(p.key))" class="perm"
              ><strong>{{ p.label }}</strong> — {{ p.description }}</span
            >
          </li>
        </ul>
        <p v-if="section.note" class="note">{{ section.note }}</p>
      </section>
      <p v-if="filter && !visibleSections.length" class="muted">No permissions match “{{ filter }}”.</p>
    </ion-content>
    <ion-footer v-if="draft">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-button
            v-if="draft.role && !draft.role.isSystem && canDelete"
            color="danger"
            :disabled="busy"
            @click="emit('delete', draft.role)"
            >Delete role</ion-button
          >
        </ion-buttons>
        <ion-buttons slot="end">
          <ion-button @click="emit('close')">Cancel</ion-button>
          <ion-button
            v-if="readOnly && canCreate"
            fill="solid"
            color="primary"
            @click="emit('duplicate', draft.role!)"
            >Duplicate as custom role</ion-button
          >
          <ion-button v-if="!readOnly" fill="solid" color="primary" :disabled="busy" @click="save"
            >Save</ion-button
          >
        </ion-buttons>
      </ion-toolbar>
    </ion-footer>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { removeCircleOutline } from 'ionicons/icons';
import type { PermissionCatalogEntry, PermissionKey, RoleDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { permissionSections, rolesApi, splitGrantable, togglePermission } from './api';

export interface RoleDraft {
  /** The role being viewed or edited; absent for a new role. */
  role?: RoleDto;
  name: string;
  description: string;
  permissions: PermissionKey[];
}

const props = defineProps<{
  draft: RoleDraft | null;
  catalog: PermissionCatalogEntry[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}>();
const emit = defineEmits<{
  close: [];
  saved: [role: RoleDto];
  duplicate: [role: RoleDto];
  delete: [role: RoleDto];
}>();

const name = ref('');
const description = ref('');
const selected = ref<PermissionKey[]>([]);
const dropped = ref<PermissionKey[]>([]);
const filter = ref('');
const busy = ref(false);

const readOnly = computed(() => !!props.draft?.role && (props.draft.role.isSystem || !props.canEdit));
const title = computed(() => {
  const role = props.draft?.role;
  if (!role) return 'Create role';
  return readOnly.value ? role.name : 'Edit role';
});

watch(
  () => props.draft,
  (d) => {
    if (!d) return;
    name.value = d.name;
    description.value = d.description;
    filter.value = '';
    if (d.role?.isSystem) {
      selected.value = [...d.permissions];
      dropped.value = [];
    } else {
      const { kept, dropped: locked } = splitGrantable(d.permissions, props.catalog);
      selected.value = kept;
      dropped.value = locked;
    }
  },
);

const sections = computed(() => permissionSections(props.catalog));
const visibleSections = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return sections.value;
  return sections.value
    .map((s) => ({
      ...s,
      permissions: s.permissions.filter((p) =>
        `${p.label} ${p.description} ${p.moduleLabel} ${s.title}`.toLowerCase().includes(q),
      ),
    }))
    .filter((s) => s.permissions.length);
});

const has = (key: PermissionKey) => selected.value.includes(key);
const labelOf = (key: string) => props.catalog.find((p) => p.key === key)?.label ?? key;

function toggle(key: PermissionKey, on: boolean) {
  selected.value = togglePermission(selected.value, key, on);
}

async function save() {
  const draft = props.draft;
  if (!draft) return;
  if (name.value.trim().length < 2) return toast('Enter a role name', 'warning');
  busy.value = true;
  try {
    const input = {
      name: name.value.trim(),
      description: description.value.trim() || null,
      permissions: selected.value,
    };
    const role = draft.role ? await rolesApi.update(draft.role.id, input) : await rolesApi.create(input);
    await toast(draft.role ? `${role.name} saved` : `${role.name} created`);
    emit('saved', role);
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.fields {
  margin-bottom: 8px;
}
.permissions-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 8px;
}
.permissions-head h2 {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
}
.section {
  margin: 12px 0 4px;
}
.section h3 {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ion-color-medium);
  margin: 16px 0 6px;
}
.section ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.section li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
}
.section ion-checkbox {
  --size: 18px;
  width: 100%;
}
.section ion-checkbox::part(label) {
  white-space: normal;
  margin-inline-start: 10px;
}
.perm {
  font-size: 0.92rem;
  line-height: 1.35;
}
.locked .perm,
.locked h3 {
  color: var(--ion-color-medium);
}
.locked {
  opacity: 0.75;
}
.lock-icon {
  flex: none;
  font-size: 18px;
  color: var(--ion-color-medium);
  margin-top: 1px;
}
.note {
  font-size: 0.82rem;
  color: var(--ion-color-medium);
  margin: 4px 0 0;
}
.dropped {
  font-size: 0.85rem;
  color: var(--ion-color-warning-shade);
}
@media (min-width: 768px) {
  ion-modal.role-editor {
    --width: 640px;
    --height: 85%;
  }
}
</style>
