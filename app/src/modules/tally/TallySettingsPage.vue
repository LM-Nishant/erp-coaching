<template>
  <AppPage title="Tally settings" back-href="/accounting/tally" :on-refresh="load">
    <ion-list v-if="scopes.length > 1">
      <ion-item>
        <ion-select v-model="scope" label="Settings for" label-placement="stacked">
          <ion-select-option v-for="s in scopes" :key="s.key" :value="s.key">{{ s.label }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>
    <p class="muted">
      {{
        level === 'institute'
          ? 'Institute settings apply to exports of all branches and to branches without settings of their own.'
          : "Branch settings apply to this branch's exports. Anything not set here uses the institute's settings."
      }}
    </p>

    <ion-segment v-model="tab">
      <ion-segment-button value="mapping">Ledgers</ion-segment-button>
      <ion-segment-button value="settings">Company</ion-segment-button>
      <ion-segment-button value="list">Tally list</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'mapping' && mapping">
      <ion-list v-if="mapping.conflicts.length">
        <ion-list-header color="danger">
          <ion-label>Exports are blocked: a Tally ledger is mapped under different groups</ion-label>
        </ion-list-header>
        <ion-item v-for="c in mapping.conflicts" :key="c.tallyName">
          <ion-label class="ion-text-wrap">
            <h3>{{ c.tallyName }}</h3>
            <p>Under {{ c.groups.join(' and ') }}, for {{ c.accounts.map(labelOf).join(', ') }}</p>
          </ion-label>
        </ion-item>
      </ion-list>
      <p v-if="mapping.unknownGroups.length" class="warning">
        Create these groups in Tally before importing (they are not predefined{{
          mapping.knownLedgers ? ' or in the imported Tally list' : ''
        }}): {{ mapping.unknownGroups.join(', ') }}
      </p>
      <p v-if="receivableMode === 'party'" class="muted">
        Student dues and advances post to a ledger for each student, "Name (Admission no.)", under the group
        of Student fees receivable.
      </p>
      <ion-searchbar v-model="filter" :debounce="0" placeholder="Find an account, ledger or group" />
      <template v-for="section in sections" :key="section.kind">
        <ion-list>
          <ion-list-header>
            <ion-label>{{ section.title }}</ion-label>
          </ion-list-header>
          <ion-item
            v-for="item in section.items"
            :key="item.account"
            :button="canConfigure"
            :detail="canConfigure"
            @click="edit(item)"
          >
            <ion-label class="ion-text-wrap">
              <h3>{{ item.label }}</h3>
              <p>
                <strong>{{ item.tallyName }}</strong> · {{ item.parentGroup }}
              </p>
              <p
                v-if="item.existsInTally && item.tallyParent && item.tallyParent !== item.parentGroup"
                class="warning"
              >
                In Tally under {{ item.tallyParent }}, not {{ item.parentGroup }}
              </p>
              <p v-else-if="item.existsInTally" class="ok">In Tally</p>
              <p v-else-if="item.existsInTally === false">Not in Tally yet: the masters file creates it</p>
              <p v-if="!item.groupKnown" class="warning">Group not in Tally</p>
              <p v-if="!item.used" class="muted">No entries yet</p>
            </ion-label>
            <ion-badge slot="end" :color="badgeColor(item)">{{ SOURCE_LABELS[item.source] }}</ion-badge>
          </ion-item>
        </ion-list>
      </template>
      <p v-if="!sections.length" class="muted">No accounts match.</p>
    </template>

    <template v-if="tab === 'settings' && settings">
      <ion-list>
        <ion-item>
          <ion-input
            v-model="form.companyName"
            label="Tally company name"
            label-placement="stacked"
            :maxlength="150"
            :placeholder="settings.inherited.companyName ?? 'Any: the company open in Tally'"
            :readonly="!canConfigure"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.receivableMode"
            label="Student dues in Tally"
            label-placement="stacked"
            :disabled="!canConfigure"
          >
            <ion-select-option value="inherit">{{
              inheritLabel(RECEIVABLE_LABELS[settings.inherited.receivableMode])
            }}</ion-select-option>
            <ion-select-option v-for="(text, key) in RECEIVABLE_LABELS" :key="key" :value="key">{{
              text
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.gstLedgers"
            label="GST ledgers"
            label-placement="stacked"
            :disabled="!canConfigure"
          >
            <ion-select-option value="inherit">{{
              inheritLabel(GST_LABELS[settings.inherited.gstLedgers])
            }}</ion-select-option>
            <ion-select-option v-for="(text, key) in GST_LABELS" :key="key" :value="key">{{
              text
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-list-header>
          <ion-label>Tally voucher types</ion-label>
        </ion-list-header>
        <ion-item v-for="key in TALLY_VOUCHER_TYPE_KEYS" :key="key">
          <ion-input
            v-model="form.voucherTypes[key]"
            :label="VOUCHER_TYPE_LABELS[key]"
            label-placement="stacked"
            :maxlength="50"
            :placeholder="settings.inherited.voucherTypes[key]"
            :readonly="!canConfigure"
          />
        </ion-item>
      </ion-list>
      <p class="muted">
        Blank fields use {{ level === 'branch' ? "the institute's settings" : "Tally's defaults" }}, shown in
        grey. A custom voucher type must already exist in Tally; use a type of the Journal class for fee
        charges.
      </p>
      <ion-button v-if="canConfigure" expand="block" :disabled="saving" @click="saveSettings"
        >Save</ion-button
      >
    </template>

    <template v-if="tab === 'list'">
      <p class="muted">
        Import the list of ledgers from Tally so the mapping can use the ledgers you already have and the
        masters file creates only the missing ones. In TallyPrime: Alt+G (Go To) › List of Accounts › Ledgers,
        then Alt+E (Export) › Current; press C (Configure), set File Format to XML (Data Interchange) and Type
        of Master to All Masters. In Tally.ERP 9: Display › List of Accounts, then Alt+E in the XML format.
      </p>
      <ion-list>
        <ion-item v-if="known?.info">
          <ion-label class="ion-text-wrap">
            <h3>{{ known.info.ledgers }} ledgers and {{ known.info.groups }} groups</h3>
            <p>
              Imported {{ formatDateTime(known.info.importedAt) }}
              <span v-if="listInherited"> for the institute. This branch has no list of its own.</span>
            </p>
          </ion-label>
          <ion-button
            v-if="canConfigure && !listInherited"
            slot="end"
            fill="clear"
            color="danger"
            :disabled="saving"
            @click="clearList"
            >Remove</ion-button
          >
        </ion-item>
        <ion-item v-else>
          <ion-label class="muted">No Tally list imported.</ion-label>
        </ion-item>
      </ion-list>
      <div v-if="canConfigure" class="upload">
        <label for="tally-ledger-list">
          {{ known?.info && !listInherited ? 'Replace the list' : 'Import a list' }}: XML file from Tally, up
          to {{ TALLY_LIMITS.maxLedgerListMb }} MB
        </label>
        <input
          id="tally-ledger-list"
          ref="fileInput"
          type="file"
          accept=".xml,application/xml,text/xml"
          :disabled="saving"
          @change="importList"
        />
      </div>
      <template v-if="known?.info">
        <ion-searchbar v-model="listSearch" :debounce="300" placeholder="Find a ledger or group" />
        <ion-list>
          <ion-list-header>
            <ion-label>Ledgers</ion-label>
          </ion-list-header>
          <ion-item v-for="l in known.ledgers.slice(0, SHOWN)" :key="l.name">
            <ion-label class="ion-text-wrap">{{ l.name }}</ion-label>
            <ion-note slot="end">{{ l.parent }}</ion-note>
          </ion-item>
          <ion-item v-if="!known.ledgers.length">
            <ion-label class="muted">No ledgers match.</ion-label>
          </ion-item>
          <ion-item v-if="known.ledgers.length > SHOWN" lines="none">
            <ion-label class="muted">Showing {{ SHOWN }} ledgers. Search to find others.</ion-label>
          </ion-item>
        </ion-list>
        <ion-list v-if="known.groups.length">
          <ion-list-header>
            <ion-label>Groups</ion-label>
          </ion-list-header>
          <ion-item v-for="g in known.groups.slice(0, SHOWN)" :key="g.name">
            <ion-label class="ion-text-wrap">{{ g.name }}</ion-label>
            <ion-note slot="end">{{ g.parent ?? 'Primary' }}</ion-note>
          </ion-item>
        </ion-list>
      </template>
    </template>

    <ion-modal :is-open="!!editing" @did-dismiss="editing = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editing?.item.label }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="editing = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="editing" class="ion-padding">
        <p class="muted">
          App account {{ editing.item.account }}. Default: {{ editing.item.defaultName }} under
          {{ editing.item.defaultGroup }}.
        </p>
        <ion-list>
          <ion-item>
            <ion-input
              v-model="editing.draft.tallyName"
              label="Tally ledger"
              label-placement="stacked"
              :maxlength="TALLY_LIMITS.maxNameLength"
              :placeholder="editing.item.inheritedName"
              :clear-input="true"
              @ion-focus="suggestFor = 'ledger'"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="editing.draft.parentGroup"
              label="Under group"
              label-placement="stacked"
              :maxlength="TALLY_LIMITS.maxNameLength"
              :placeholder="editing.item.inheritedGroup"
              :clear-input="true"
              @ion-focus="suggestFor = 'group'"
            />
          </ion-item>
        </ion-list>
        <ion-list v-if="suggestions.length">
          <ion-list-header>
            <ion-label>{{ suggestFor === 'ledger' ? 'Ledgers in Tally' : 'Groups' }}</ion-label>
          </ion-list-header>
          <ion-item v-for="s in suggestions" :key="`${s.kind}:${s.name}`" button @click="pick(s)">
            <ion-label class="ion-text-wrap">{{ s.name }}</ion-label>
            <ion-note v-if="s.parent" slot="end">{{ s.parent }}</ion-note>
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving" @click="saveItem">Save</ion-button>
        <ion-button
          v-if="editing.item.source === level"
          expand="block"
          fill="outline"
          :disabled="saving"
          @click="resetItem"
        >
          Use {{ level === 'branch' ? "the institute's" : 'the default' }}: {{ editing.item.inheritedName }}
        </ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue';
import {
  TALLY_LIMITS,
  TALLY_PREDEFINED_GROUPS,
  TALLY_VOUCHER_TYPE_KEYS,
  type TallyAccountKind,
  type TallyGstLedgers,
  type TallyKnownLedgerDto,
  type TallyKnownLedgersDto,
  type TallyMappingDto,
  type TallyMappingItemDto,
  type TallyMappingUpdate,
  type TallyReceivableMode,
  type TallySettingsDto,
  type TallyVoucherTypeKey,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import {
  SOURCE_LABELS,
  draftOf,
  formatDateTime,
  mappingChanges,
  scopeOptions,
  tallyApi,
  type MappingDraft,
  type ScopeKey,
} from './api';

const RECEIVABLE_LABELS: Record<TallyReceivableMode, string> = {
  control: 'One ledger for all students',
  party: 'A ledger for each student',
};
const GST_LABELS: Record<TallyGstLedgers, string> = {
  split: 'Output CGST, SGST and IGST',
  single: 'One Output GST ledger',
};
const VOUCHER_TYPE_LABELS: Record<TallyVoucherTypeKey, string> = {
  receipt: 'Receipts (money received)',
  payment: 'Payments (money paid out)',
  contra: 'Contra (cash and bank transfers)',
  journal: 'Journals (adjustments)',
  feeCharge: 'Fee charges and invoices',
};
const KIND_TITLES: Record<TallyAccountKind, string> = {
  core: 'Fees and students',
  tax: 'GST',
  bank: 'Bank accounts',
  gateway: 'Payment gateways',
  expense: 'Expense heads',
  income: 'Other income heads',
};
const PREDEFINED_GROUPS = Object.keys(TALLY_PREDEFINED_GROUPS);
const SHOWN = 200;

const auth = useAuthStore();
const canConfigure = computed(() => auth.can('tally.configure'));
const scopes = computed(() => scopeOptions(auth.me, auth.activeBranchId));
const scope = ref<ScopeKey | undefined>();
const level = computed(() => (scope.value === 'all' ? 'institute' : 'branch'));
const tab = ref<'mapping' | 'settings' | 'list'>('mapping');

const settings = ref<TallySettingsDto | null>(null);
const mapping = ref<TallyMappingDto | null>(null);
const known = ref<TallyKnownLedgersDto | null>(null);
const saving = ref(false);
const listSearch = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const receivableMode = computed(() => settings.value?.effective.receivableMode);
/** A branch without its own Tally list uses the institute's. */
const listInherited = computed(() => level.value === 'branch' && known.value?.info?.branchId === null);

async function load() {
  if (!scope.value) return;
  try {
    [settings.value, mapping.value, known.value] = await Promise.all([
      tallyApi.settings(scope.value),
      tallyApi.mapping(scope.value),
      tallyApi.knownLedgers(scope.value, listSearch.value.trim() || undefined),
    ]);
    fillForm();
  } catch (e) {
    void toastError(e);
  }
}

watch(
  scopes,
  (list) => {
    if (!list.some((s) => s.key === scope.value)) scope.value = list[0]?.key;
  },
  { immediate: true },
);
watch(scope, (now, before) => {
  if (before !== undefined && now !== undefined) void load();
});

// Mapping

const filter = ref('');
const sections = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const items = (mapping.value?.items ?? []).filter(
    (i) =>
      !q || [i.label, i.account, i.tallyName, i.parentGroup].some((text) => text.toLowerCase().includes(q)),
  );
  return (Object.keys(KIND_TITLES) as TallyAccountKind[])
    .map((kind) => ({ kind, title: KIND_TITLES[kind], items: items.filter((i) => i.kind === kind) }))
    .filter((s) => s.items.length);
});
const labelOf = (account: string) =>
  mapping.value?.items.find((i) => i.account === account)?.label ?? account;
const badgeColor = (item: TallyMappingItemDto) =>
  item.source === 'default' ? 'medium' : item.source === level.value ? 'primary' : 'tertiary';

const editing = ref<{ item: TallyMappingItemDto; draft: MappingDraft } | null>(null);
const suggestFor = ref<'ledger' | 'group' | null>(null);
const suggestions = ref<TallyKnownLedgerDto[]>([]);

function edit(item: TallyMappingItemDto) {
  if (!canConfigure.value) return;
  suggestFor.value = null;
  suggestions.value = [];
  editing.value = { item, draft: draftOf(item) };
}

let suggestSeq = 0;
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [suggestFor.value, editing.value?.draft.tallyName, editing.value?.draft.parentGroup] as const,
  ([kind, name, group]) => {
    clearTimeout(suggestTimer);
    if (!kind || !editing.value) {
      suggestions.value = [];
      return;
    }
    const text = (kind === 'ledger' ? name : group)?.trim() ?? '';
    suggestTimer = setTimeout(() => void suggest(kind, text), 250);
  },
);

/** Ledgers from the imported Tally list; groups from Tally's predefined groups and the imported list. */
async function suggest(kind: 'ledger' | 'group', text: string) {
  const seq = ++suggestSeq;
  const q = text.toLowerCase();
  const predefined: TallyKnownLedgerDto[] =
    kind === 'group'
      ? PREDEFINED_GROUPS.filter((g) => g.toLowerCase().includes(q)).map((name) => ({
          kind: 'group',
          name,
          parent: TALLY_PREDEFINED_GROUPS[name] ?? null,
        }))
      : [];
  let imported: TallyKnownLedgerDto[] = [];
  if (mapping.value?.knownLedgers && scope.value) {
    try {
      const res = await tallyApi.knownLedgers(scope.value, text || undefined);
      imported = kind === 'ledger' ? res.ledgers : res.groups;
    } catch {
      // Suggestions are optional; typing a name still works.
    }
  }
  if (seq !== suggestSeq) return;
  const seen = new Set<string>();
  const current =
    (kind === 'ledger' ? editing.value?.draft.tallyName : editing.value?.draft.parentGroup) ?? '';
  suggestions.value = [...imported, ...predefined]
    .filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key) || key === current.trim().toLowerCase()) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function pick(s: TallyKnownLedgerDto) {
  if (!editing.value) return;
  if (s.kind === 'ledger') {
    editing.value.draft.tallyName = s.name;
    if (s.parent) editing.value.draft.parentGroup = s.parent;
  } else {
    editing.value.draft.parentGroup = s.name;
  }
  suggestFor.value = null;
}

async function saveMapping(items: TallyMappingUpdate['items']) {
  saving.value = true;
  try {
    mapping.value = await tallyApi.saveMapping(scope.value, items);
    editing.value = null;
    await toast('Ledger mapping saved');
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

async function saveItem() {
  if (!editing.value) return;
  const { item, draft } = editing.value;
  const items = mappingChanges([item], { [item.account]: draft }, level.value);
  if (!items.length) {
    editing.value = null;
    return;
  }
  await saveMapping(items);
}

async function resetItem() {
  if (editing.value) await saveMapping([{ account: editing.value.item.account, tallyName: null }]);
}

// Company and voucher settings

const blankVoucherTypes = () =>
  Object.fromEntries(TALLY_VOUCHER_TYPE_KEYS.map((k) => [k, ''])) as Record<TallyVoucherTypeKey, string>;
const form = reactive({
  companyName: '',
  receivableMode: 'inherit' as TallyReceivableMode | 'inherit',
  gstLedgers: 'inherit' as TallyGstLedgers | 'inherit',
  voucherTypes: blankVoucherTypes(),
});

function fillForm() {
  const values = settings.value?.values;
  form.companyName = values?.companyName ?? '';
  form.receivableMode = values?.receivableMode ?? 'inherit';
  form.gstLedgers = values?.gstLedgers ?? 'inherit';
  form.voucherTypes = Object.fromEntries(
    TALLY_VOUCHER_TYPE_KEYS.map((k) => [k, values?.voucherTypes?.[k] ?? '']),
  ) as Record<TallyVoucherTypeKey, string>;
}

const inheritLabel = (text: string) =>
  level.value === 'branch' ? `As the institute: ${text.toLowerCase()}` : `Default: ${text.toLowerCase()}`;

async function saveSettings() {
  saving.value = true;
  try {
    settings.value = await tallyApi.saveSettings(scope.value, {
      companyName: form.companyName.trim() || null,
      receivableMode: form.receivableMode === 'inherit' ? null : form.receivableMode,
      gstLedgers: form.gstLedgers === 'inherit' ? null : form.gstLedgers,
      voucherTypes: Object.fromEntries(
        TALLY_VOUCHER_TYPE_KEYS.map((k) => [k, form.voucherTypes[k].trim() || null]),
      ),
    });
    fillForm();
    // The receivable mode and GST ledgers change which ledgers the mapping lists.
    mapping.value = await tallyApi.mapping(scope.value);
    await toast('Tally settings saved');
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

// Tally ledger list

watch(listSearch, async () => {
  if (!scope.value) return;
  try {
    known.value = await tallyApi.knownLedgers(scope.value, listSearch.value.trim() || undefined);
  } catch (e) {
    void toastError(e);
  }
});

async function importList(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > TALLY_LIMITS.maxLedgerListMb * 1024 * 1024) {
    void toast(`The file is larger than ${TALLY_LIMITS.maxLedgerListMb} MB`, 'danger');
    input.value = '';
    return;
  }
  saving.value = true;
  try {
    const result = await tallyApi.importLedgers(scope.value, file);
    await toast(
      `Imported ${result.ledgers} ledgers and ${result.groups} groups. ${result.matched} mapped ledgers are in Tally, ${result.missing} are created by the masters file.`,
    );
    listSearch.value = '';
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function clearList() {
  saving.value = true;
  try {
    await tallyApi.clearLedgers(scope.value);
    await toast('Tally list removed');
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.upload {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 16px;
}
.warning {
  color: var(--ion-color-warning-shade);
}
.ok {
  color: var(--ion-color-success-shade);
}
</style>
