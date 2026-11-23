<template>
  <form @submit.prevent="save">
    <ion-list>
      <ion-item>
        <ion-input
          v-model="draft.displayName"
          label="Public name"
          label-placement="stacked"
          required
          data-testid="profile-name"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model="draft.headline"
          label="Headline"
          label-placement="stacked"
          placeholder="e.g. Python developer and teacher"
          :maxlength="200"
        />
      </ion-item>
      <ion-item>
        <ion-textarea v-model="draft.bio" label="About you" label-placement="stacked" auto-grow :rows="4" />
      </ion-item>
      <ion-item>
        <ion-input v-model="draft.website" label="Website" label-placement="stacked" placeholder="https://" />
      </ion-item>
    </ion-list>
    <ion-button
      type="submit"
      expand="block"
      :disabled="busy || !draft.displayName.trim()"
      data-testid="profile-save"
      >{{ submitLabel }}</ion-button
    >
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonInput, IonItem, IonList, IonTextarea } from '@ionic/vue';
import type { MktInstructorProfileInput, MktSellerAdminDto } from '@erp/shared';

const props = defineProps<{ profile?: MktSellerAdminDto | null; busy?: boolean; submitLabel: string }>();
const emit = defineEmits<{ save: [MktInstructorProfileInput] }>();
const draft = ref({
  displayName: props.profile?.displayName ?? '',
  headline: props.profile?.headline ?? '',
  bio: props.profile?.bio ?? '',
  website: props.profile?.website ?? '',
});

function save() {
  emit('save', {
    displayName: draft.value.displayName.trim(),
    headline: draft.value.headline.trim() || null,
    bio: draft.value.bio.trim() || null,
    website: draft.value.website.trim() || null,
  });
}
</script>
