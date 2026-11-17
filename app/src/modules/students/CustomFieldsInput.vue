<template>
  <template v-for="f in fields" :key="f.key">
    <ion-item v-if="f.type === 'checkbox'">
      <ion-checkbox :checked="!!model[f.key]" @ion-change="set(f.key, $event.detail.checked)">
        {{ f.label }}{{ f.required ? ' *' : '' }}
      </ion-checkbox>
    </ion-item>
    <ion-item v-else-if="f.type === 'select'">
      <ion-select
        :value="model[f.key]"
        :label="f.label + (f.required ? ' *' : '')"
        label-placement="stacked"
        interface="popover"
        @ion-change="set(f.key, $event.detail.value)"
      >
        <ion-select-option v-for="o in f.options ?? []" :key="o" :value="o">{{ o }}</ion-select-option>
      </ion-select>
    </ion-item>
    <ion-item v-else-if="f.type === 'textarea'">
      <ion-textarea
        :value="(model[f.key] as string) ?? ''"
        :label="f.label + (f.required ? ' *' : '')"
        label-placement="stacked"
        :helper-text="f.helpText"
        auto-grow
        @ion-input="set(f.key, $event.detail.value)"
      />
    </ion-item>
    <ion-item v-else>
      <ion-input
        :value="(model[f.key] as string | number) ?? ''"
        :label="f.label + (f.required ? ' *' : '')"
        label-placement="stacked"
        :type="inputType(f.type)"
        :helper-text="f.helpText"
        :required="f.required"
        @ion-input="set(f.key, f.type === 'number' ? toNumber($event.detail.value) : $event.detail.value)"
      />
    </ion-item>
  </template>
</template>

<script setup lang="ts">
import { IonCheckbox, IonInput, IonItem, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import type { FormFieldDef, FormFieldType } from '@erp/shared';

/** Renders institute-defined custom form fields into a `customFields` object. */
defineProps<{ fields: FormFieldDef[] }>();
const model = defineModel<Record<string, unknown>>({ required: true });

function set(key: string, value: unknown) {
  model.value = { ...model.value, [key]: value === '' ? undefined : value };
}

const toNumber = (v: string | null | undefined) => (v === '' || v == null ? undefined : Number(v));

type InputType = 'text' | 'number' | 'date' | 'email' | 'tel';
const INPUT_TYPES: Partial<Record<FormFieldType, InputType>> = {
  number: 'number',
  date: 'date',
  email: 'email',
  phone: 'tel',
};
const inputType = (t: FormFieldType): InputType => INPUT_TYPES[t] ?? 'text';
</script>
