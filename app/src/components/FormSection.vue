<template>
  <section class="form-section">
    <template v-if="advanced">
      <button type="button" class="toggle" :aria-expanded="open" @click="open = !open">
        <span>{{ title ?? (open ? t('common.actions.showLess') : t('common.actions.showMore')) }}</span>
        <ion-icon :icon="open ? chevronUpOutline : chevronDownOutline" aria-hidden="true" />
      </button>
      <div v-if="open" class="body"><slot /></div>
    </template>
    <template v-else>
      <h3 v-if="title" class="heading">{{ title }}</h3>
      <div class="body"><slot /></div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { IonIcon } from '@ionic/vue';
import { chevronDownOutline, chevronUpOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';

/**
 * Progressive disclosure for forms: the fields most people need go in plain sections; rarely used ones in
 * `<FormSection advanced>`, collapsed behind "Show more options" (open with `v-model:open`, e.g. when
 * editing a record whose advanced fields are set).
 */
withDefaults(defineProps<{ title?: string; advanced?: boolean }>(), { title: undefined, advanced: false });
const open = defineModel<boolean>('open', { default: false });
const { t } = useI18n();
</script>

<style scoped>
.form-section {
  margin: 0 0 16px;
}
.heading {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ion-color-medium-shade);
}
.toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: var(--app-tap-target);
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--ion-color-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
</style>
