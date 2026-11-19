<template>
  <ion-item v-for="f in fields" :key="`${kind}-${f.key}`">
    <ion-select
      v-if="f.options"
      :model-value="values[f.key] ?? ''"
      :label="label(f)"
      label-placement="stacked"
      interface="popover"
      :helper-text="f.help"
      @update:model-value="set(f.key, $event)"
    >
      <ion-select-option value="">Default</ion-select-option>
      <ion-select-option v-for="o in f.options" :key="o.value" :value="o.value">{{
        o.label
      }}</ion-select-option>
    </ion-select>
    <ion-textarea
      v-else-if="f.multiline"
      :model-value="values[f.key] ?? ''"
      :label="label(f)"
      label-placement="stacked"
      :auto-grow="true"
      :rows="3"
      autocomplete="off"
      :spellcheck="false"
      :placeholder="placeholder(f)"
      :helper-text="f.help"
      @update:model-value="set(f.key, $event)"
    />
    <ion-input
      v-else
      :model-value="values[f.key] ?? ''"
      :label="label(f)"
      label-placement="stacked"
      :type="f.secret ? 'password' : 'text'"
      autocomplete="off"
      :placeholder="placeholder(f)"
      :helper-text="f.help"
      @update:model-value="set(f.key, $event)"
    />
  </ion-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IonInput, IonItem, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import {
  providerFieldsFor,
  type ExternalChannel,
  type MessagingProviderKind,
  type ProviderField,
} from '@erp/shared';

/** Credential and option fields of a messaging provider (institute and platform settings). */
const props = defineProps<{
  kind: MessagingProviderKind;
  channel: ExternalChannel;
  /** Platform default provider: also shows platform-only fields (login OTP template). */
  platform?: boolean;
  /** Masked hints of the saved secrets (only while the saved provider is selected). */
  secretHints?: Record<string, string>;
}>();
const values = defineModel<Record<string, string>>({ required: true });

const fields = computed(() => providerFieldsFor(props.kind, props.channel, { platform: props.platform }));

const label = (f: ProviderField) => f.label + (f.required ? ' *' : '');

function placeholder(f: ProviderField) {
  const hint = f.secret ? props.secretHints?.[f.key] : undefined;
  return hint ? `Saved (${hint}); blank keeps it` : (f.placeholder ?? '');
}

function set(key: string, value: unknown) {
  values.value = { ...values.value, [key]: value == null ? '' : String(value) };
}
</script>
