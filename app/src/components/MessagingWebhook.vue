<template>
  <div class="webhook">
    <p class="muted small">{{ HINTS[kind] ?? 'Paste this URL into the vendor dashboard.' }}</p>
    <div class="row">
      <span class="name">Webhook URL</span>
      <code>{{ webhook.url }}</code>
      <ion-button
        fill="clear"
        size="small"
        aria-label="Copy webhook URL"
        @click="copy(webhook.url, 'Webhook URL')"
      >
        <ion-icon slot="icon-only" :icon="copyOutline" />
      </ion-button>
    </div>
    <div v-if="webhook.verifyToken" class="row">
      <span class="name">Verify token</span>
      <code>{{ webhook.verifyToken }}</code>
      <ion-button
        fill="clear"
        size="small"
        aria-label="Copy verify token"
        @click="copy(webhook.verifyToken, 'Verify token')"
      >
        <ion-icon slot="icon-only" :icon="copyOutline" />
      </ion-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IonButton, IonIcon } from '@ionic/vue';
import { copyOutline } from 'ionicons/icons';
import type { MessagingWebhookDto } from '@erp/shared';
import { toast } from '@/core/toast';

/** Delivery-status webhook of a saved messaging provider (pasted into the vendor dashboard). */
defineProps<{ kind: string; webhook: MessagingWebhookDto }>();

const HINTS: Record<string, string> = {
  msg91: 'MSG91 → Webhooks: add this URL for SMS and WhatsApp delivery reports (and inbound replies).',
  twilio:
    'Delivery status is reported here automatically. For STOP/START replies, also set it as the incoming-message webhook of your number or Messaging Service.',
  'whatsapp-cloud':
    'Meta app → WhatsApp → Configuration: paste the URL and verify token, then subscribe to the "messages" field.',
};

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    await toast(`${what} copied`);
  } catch {
    await toast('Copy failed; select the text instead', 'warning');
  }
}
</script>

<style scoped>
.webhook {
  margin: 8px 0;
}
.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}
.name {
  font-weight: 600;
}
code {
  word-break: break-all;
}
.small {
  font-size: 13px;
}
</style>
