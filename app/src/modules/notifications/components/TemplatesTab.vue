<template>
  <div>
    <ion-button v-can="'notifications.edit'" expand="block" @click="openEditor()">
      <ion-icon slot="start" :icon="add" /> New template
    </ion-button>
    <p class="muted">
      Events without a template use the built-in default text. Use
      <code v-pre>{{ variable }}</code> placeholders.
    </p>
    <ion-list>
      <ion-item v-for="t in templates" :key="t.id">
        <ion-label>
          <h3>
            {{ eventLabel(t.eventKey) }} · {{ CHANNEL_LABELS[t.channel] }}
            <ion-badge v-if="!t.isActive" color="medium">inactive</ion-badge>
          </h3>
          <p v-if="t.subject">{{ t.subject }}</p>
          <p>{{ t.body }}</p>
        </ion-label>
        <ion-button
          slot="end"
          v-can="'notifications.edit'"
          fill="clear"
          aria-label="Edit template"
          @click="openEditor(t)"
        >
          <ion-icon slot="icon-only" :icon="createOutline" />
        </ion-button>
        <ion-button
          slot="end"
          v-can="'notifications.edit'"
          fill="clear"
          color="danger"
          aria-label="Delete template"
          @click="remove(t)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!loading && !templates.length">
        <ion-label class="muted">No custom templates — defaults are used.</ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ editingId ? 'Edit template' : 'New template' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item>
              <ion-select
                v-model="form.eventKey"
                label="Event"
                label-placement="stacked"
                :disabled="!!editingId"
                interface="popover"
                @ion-change="useDefault"
              >
                <ion-select-option v-for="e in events" :key="e.key" :value="e.key"
                  >{{ e.category }} — {{ e.label }}</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.channel"
                label="Channel"
                label-placement="stacked"
                :disabled="!!editingId"
                interface="popover"
              >
                <ion-select-option v-for="c in NOTIFICATION_CHANNELS" :key="c" :value="c">{{
                  CHANNEL_LABELS[c]
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="form.channel !== 'sms'">
              <ion-input v-model="form.subject" label="Title / subject" label-placement="stacked" />
            </ion-item>
            <ion-item>
              <ion-textarea v-model="form.body" label="Body" label-placement="stacked" auto-grow required />
            </ion-item>
            <ion-item v-if="form.channel === 'sms' || form.channel === 'whatsapp'">
              <ion-input
                v-model="form.providerTemplateId"
                label="Provider template id (DLT / WhatsApp)"
                label-placement="stacked"
                helper-text="SMS: DLT template id, MSG91 template id or Twilio Content SID (HX…). WhatsApp: approved template name, optionally name:language. Body placeholders fill the template variables in order."
              />
            </ion-item>
            <ion-item>
              <ion-toggle v-model="form.isActive">Active</ion-toggle>
            </ion-item>
          </ion-list>
          <p v-if="currentEvent" class="muted">
            Variables: {{ ['recipient.name', 'institute.name', ...currentEvent.variables].join(', ') }}
          </p>
          <ion-button fill="outline" expand="block" @click="preview">Preview</ion-button>
          <ion-card v-if="previewText">
            <ion-card-content>
              <strong v-if="previewText.subject">{{ previewText.subject }}<br /></strong
              >{{ previewText.body }}
            </ion-card-content>
          </ion-card>
          <ion-button expand="block" type="submit" :disabled="saving">Save</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
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
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import { add, createOutline, trashOutline } from 'ionicons/icons';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationEventDef,
  type NotificationTemplateDto,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { CHANNEL_LABELS, commsApi } from '../api';

interface TemplateForm {
  eventKey: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  providerTemplateId: string;
  isActive: boolean;
}

const templates = ref<NotificationTemplateDto[]>([]);
const events = ref<NotificationEventDef[]>([]);
const loading = ref(true);
const saving = ref(false);
const form = ref<TemplateForm | null>(null);
const editingId = ref<number | null>(null);
const previewText = ref<{ subject: string | null; body: string } | null>(null);

const currentEvent = computed(() => events.value.find((e) => e.key === form.value?.eventKey));
const eventLabel = (key: string) => events.value.find((e) => e.key === key)?.label ?? key;

async function load() {
  loading.value = true;
  try {
    [templates.value, events.value] = await Promise.all([commsApi.templates(), commsApi.events()]);
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(t?: NotificationTemplateDto) {
  editingId.value = t?.id ?? null;
  previewText.value = null;
  const ev = events.value[0];
  form.value = {
    eventKey: t?.eventKey ?? ev?.key ?? '',
    channel: t?.channel ?? 'sms',
    subject: t?.subject ?? (t ? '' : (ev?.title ?? '')),
    body: t?.body ?? ev?.body ?? '',
    providerTemplateId: t?.providerTemplateId ?? '',
    isActive: t?.isActive ?? true,
  };
}

function useDefault() {
  if (editingId.value || !form.value || !currentEvent.value) return;
  form.value.subject = currentEvent.value.title;
  form.value.body = currentEvent.value.body;
}

async function preview() {
  if (!form.value) return;
  try {
    previewText.value = await commsApi.preview({
      eventKey: form.value.eventKey,
      subject: form.value.subject || null,
      body: form.value.body,
    });
  } catch (e) {
    await toastError(e);
  }
}

async function save() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  const body = {
    subject: f.subject || null,
    body: f.body,
    providerTemplateId: f.providerTemplateId || null,
    isActive: f.isActive,
  };
  try {
    if (editingId.value) await commsApi.updateTemplate(editingId.value, body);
    else await commsApi.createTemplate({ ...body, eventKey: f.eventKey, channel: f.channel });
    form.value = null;
    await toast('Template saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(t: NotificationTemplateDto) {
  const alert = await alertController.create({
    header: 'Delete template?',
    message: 'The default text will be used again.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () => commsApi.removeTemplate(t.id).then(load).catch(toastError),
      },
    ],
  });
  await alert.present();
}

onMounted(load);
</script>
