<template>
  <div class="panel">
    <ion-segment v-model="tab" scrollable>
      <ion-segment-button value="chat"><ion-label>Chat</ion-label></ion-segment-button>
      <ion-segment-button value="qa">
        <ion-label>Q&amp;A{{ openQuestions ? ` (${openQuestions})` : '' }}</ion-label>
      </ion-segment-button>
      <ion-segment-button value="polls"><ion-label>Polls</ion-label></ion-segment-button>
      <ion-segment-button value="people">
        <ion-label
          >People{{
            isModerator && room.hands.length ? ` ✋${room.hands.length}` : ` (${online.length})`
          }}</ion-label
        >
      </ion-segment-button>
    </ion-segment>

    <!-- Chat -->
    <div v-if="tab === 'chat'" class="body">
      <div ref="chatList" class="scroll">
        <p v-if="!room.chat.length" class="muted">No messages yet.</p>
        <div v-for="m in room.chat" :key="m.id" class="msg" :class="{ mine: m.user.id === room.me?.id }">
          <strong>{{ m.user.name }}</strong>
          <span class="time">{{ time(m.createdAt) }}</span>
          <div>{{ m.body }}</div>
        </div>
      </div>
      <form class="composer" @submit.prevent="send">
        <ion-input v-model="chatText" placeholder="Message" :maxlength="1000" fill="outline" />
        <ion-button type="submit" :disabled="!chatText.trim()">Send</ion-button>
      </form>
    </div>

    <!-- Q&A -->
    <div v-else-if="tab === 'qa'" class="body">
      <div class="scroll">
        <p v-if="!questions.length" class="muted">No questions yet.</p>
        <ion-card v-for="q in questions" :key="q.id" class="q" :class="{ answered: q.isAnswered }">
          <ion-card-content>
            <div class="q-head">
              <strong>{{ q.user.name }}</strong>
              <ion-badge v-if="q.isAnswered" color="success">Answered</ion-badge>
            </div>
            <p>{{ q.body }}</p>
            <div class="q-actions">
              <ion-button
                size="small"
                :fill="q.upvotedByMe ? 'solid' : 'outline'"
                @click="act(() => live.upvote(q.id))"
              >
                ▲ {{ q.upvotes }}
              </ion-button>
              <ion-button
                v-if="isModerator"
                size="small"
                fill="clear"
                @click="act(() => live.answer(q.id, !q.isAnswered))"
              >
                {{ q.isAnswered ? 'Reopen' : 'Mark answered' }}
              </ion-button>
            </div>
          </ion-card-content>
        </ion-card>
      </div>
      <form class="composer" @submit.prevent="askQuestion">
        <ion-input v-model="qText" placeholder="Ask a question" :maxlength="1000" fill="outline" />
        <ion-button type="submit" :disabled="!qText.trim()">Ask</ion-button>
      </form>
    </div>

    <!-- Polls -->
    <div v-else-if="tab === 'polls'" class="body">
      <div class="scroll">
        <ion-card v-if="isModerator">
          <ion-card-content>
            <ion-input
              v-model="pollQ"
              label="New poll"
              label-placement="stacked"
              placeholder="Question"
              :maxlength="300"
            />
            <ion-input
              v-for="(_, i) in pollOptions"
              :key="i"
              v-model="pollOptions[i]"
              :placeholder="`Option ${i + 1}`"
              :maxlength="200"
            />
            <ion-button
              size="small"
              fill="clear"
              :disabled="pollOptions.length >= 10"
              @click="pollOptions.push('')"
            >
              Add option
            </ion-button>
            <ion-button size="small" :disabled="!canCreatePoll" @click="createPoll">Launch poll</ion-button>
          </ion-card-content>
        </ion-card>
        <p v-if="!room.polls.length" class="muted">No polls yet.</p>
        <ion-card v-for="p in pollsNewestFirst" :key="p.id">
          <ion-card-content>
            <div class="q-head">
              <strong>{{ p.question }}</strong>
              <ion-badge :color="p.status === 'open' ? 'primary' : 'medium'">{{ p.status }}</ion-badge>
            </div>
            <div
              v-for="(o, i) in p.options"
              :key="i"
              class="option"
              :class="{ voted: p.myVote === i, clickable: canVote(p) }"
              @click="canVote(p) && act(() => live.vote(p.id, i))"
            >
              <div class="bar" :style="{ width: pct(p, i) + '%' }" />
              <span>{{ o }}</span>
              <span v-if="showResults(p)" class="count">{{ p.counts[i] }} · {{ pct(p, i) }}%</span>
            </div>
            <div class="muted small">{{ p.totalVotes }} vote{{ p.totalVotes === 1 ? '' : 's' }}</div>
            <ion-button
              v-if="isModerator && p.status === 'open'"
              size="small"
              fill="outline"
              @click="act(() => live.closePoll(p.id))"
            >
              Close poll
            </ion-button>
          </ion-card-content>
        </ion-card>
      </div>
    </div>

    <!-- People -->
    <div v-else class="body">
      <div class="scroll">
        <ion-list>
          <ion-list-header v-if="room.hands.length"><ion-label>Raised hands</ion-label></ion-list-header>
          <ion-item v-for="h in room.hands" :key="'h' + h.id">
            <ion-label>✋ {{ h.name }}</ion-label>
            <template v-if="isModerator">
              <ion-button slot="end" size="small" @click="act(() => live.grantMic(h.id))"
                >Allow mic</ion-button
              >
              <ion-button slot="end" size="small" fill="clear" @click="act(() => live.lowerHand(h.id))"
                >Dismiss</ion-button
              >
            </template>
          </ion-item>
          <ion-list-header
            ><ion-label>In class ({{ online.length }})</ion-label></ion-list-header
          >
          <ion-item v-for="p in online" :key="p.userId">
            <ion-label>
              {{ p.name }}
              <span v-if="p.role !== 'student'" class="muted small">
                · {{ p.role === 'host' ? 'Teacher' : 'Moderator' }}</span
              >
            </ion-label>
            <template v-if="speaking(p.userId)">
              <ion-badge slot="end" color="success">🎤 Speaking</ion-badge>
              <ion-button
                v-if="isModerator"
                slot="end"
                size="small"
                color="danger"
                fill="clear"
                @click="act(() => live.revokeMic(p.userId))"
              >
                Mute
              </ion-button>
            </template>
            <ion-button
              v-else-if="isModerator && p.role === 'student'"
              slot="end"
              size="small"
              fill="clear"
              @click="act(() => live.grantMic(p.userId))"
            >
              Allow mic
            </ion-button>
          </ion-item>
          <template v-if="offline.length">
            <ion-list-header><ion-label>Left</ion-label></ion-list-header>
            <ion-item v-for="p in offline" :key="'o' + p.userId">
              <ion-label color="medium">{{ p.name }}</ion-label>
            </ion-item>
          </template>
        </ion-list>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import type { LivePollDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import type { LiveSocket } from '../composables/useLiveSocket';
import { time } from '../format';

const props = defineProps<{ live: LiveSocket }>();
const room = props.live.room;
const tab = ref<'chat' | 'qa' | 'polls' | 'people'>('chat');
const chatText = ref('');
const qText = ref('');
const pollQ = ref('');
const pollOptions = ref(['', '']);
const chatList = ref<HTMLElement | null>(null);

const isModerator = computed(() => room.me?.role === 'host' || room.me?.role === 'moderator');
const online = computed(() => room.participants.filter((p) => p.online));
const offline = computed(() => room.participants.filter((p) => !p.online));
const openQuestions = computed(() => room.questions.filter((q) => !q.isAnswered).length);
const questions = computed(() =>
  [...room.questions].sort(
    (a, b) => Number(a.isAnswered) - Number(b.isAnswered) || b.upvotes - a.upvotes || a.id - b.id,
  ),
);
const pollsNewestFirst = computed(() => [...room.polls].sort((a, b) => b.id - a.id));
const cleanOptions = computed(() => pollOptions.value.map((o) => o.trim()).filter(Boolean));
const canCreatePoll = computed(() => pollQ.value.trim() && cleanOptions.value.length >= 2);

const speaking = (id: number) => room.speakers.some((s) => s.id === id);
const canVote = (p: LivePollDto) => p.status === 'open' && room.me?.role === 'student' && p.myVote === null;
const showResults = (p: LivePollDto) => isModerator.value || p.myVote !== null || p.status === 'closed';
const pct = (p: LivePollDto, i: number) =>
  showResults(p) && p.totalVotes ? Math.round((p.counts[i] / p.totalVotes) * 100) : 0;

async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toastError(e);
  }
}

async function send() {
  const body = chatText.value.trim();
  if (!body) return;
  chatText.value = '';
  await act(() => props.live.sendChat(body));
}

async function askQuestion() {
  const body = qText.value.trim();
  if (!body) return;
  qText.value = '';
  await act(() => props.live.ask(body));
}

async function createPoll() {
  await act(async () => {
    await props.live.createPoll(pollQ.value.trim(), cleanOptions.value);
    pollQ.value = '';
    pollOptions.value = ['', ''];
  });
}

watch(
  () => room.chat.length,
  async () => {
    await nextTick();
    chatList.value?.scrollTo({ top: chatList.value.scrollHeight });
  },
);
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 360px;
}
.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.composer {
  display: flex;
  gap: 6px;
  padding: 8px;
  align-items: center;
}
.msg {
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: var(--ion-color-light);
}
.msg.mine {
  background: var(--ion-color-primary-tint);
}
.time {
  margin-left: 6px;
  font-size: 11px;
  color: var(--ion-color-medium);
}
.muted {
  color: var(--ion-color-medium);
}
.small {
  font-size: 12px;
}
.q {
  margin: 0 0 8px;
}
.q.answered {
  opacity: 0.7;
}
.q-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.q-actions {
  display: flex;
  gap: 4px;
}
.option {
  position: relative;
  display: flex;
  justify-content: space-between;
  padding: 8px 10px;
  margin: 6px 0;
  border: 1px solid var(--ion-color-medium-tint);
  border-radius: 6px;
  overflow: hidden;
}
.option span {
  position: relative;
}
.option.clickable {
  cursor: pointer;
}
.option.voted {
  border-color: var(--ion-color-primary);
  font-weight: 600;
}
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ion-color-primary);
  opacity: 0.15;
  transition: width 0.3s;
}
.count {
  font-size: 12px;
}
</style>
