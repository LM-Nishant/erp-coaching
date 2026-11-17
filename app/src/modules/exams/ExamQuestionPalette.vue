<template>
  <div class="palette">
    <div v-for="g in groups" :key="g.id" class="group">
      <div v-if="groups.length > 1" class="group-title">{{ g.title }}</div>
      <div class="grid">
        <button
          v-for="it in g.items"
          :key="it.index"
          type="button"
          class="cell"
          :class="[it.status, { current: it.index === current }]"
          :aria-label="`Question ${it.index + 1}: ${STATUS_LABELS[it.status]}`"
          @click="emit('select', it.index)"
        >
          {{ it.index + 1 }}
        </button>
      </div>
    </div>
    <div class="legend">
      <div v-for="(label, s) in STATUS_LABELS" :key="s" class="legend-item">
        <span class="cell small" :class="s" />
        <span>{{ label }} ({{ counts[s] }})</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export type PaletteStatus = 'answered' | 'not-answered' | 'marked' | 'answered-marked' | 'not-visited';

export interface PaletteItem {
  index: number;
  sectionId: number;
  status: PaletteStatus;
}

export const STATUS_LABELS: Record<PaletteStatus, string> = {
  answered: 'Answered',
  'not-answered': 'Not answered',
  marked: 'Marked for review',
  'answered-marked': 'Answered & marked',
  'not-visited': 'Not visited',
};
</script>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  items: PaletteItem[];
  sections: { id: number; title: string }[];
  current: number;
}>();
const emit = defineEmits<{ select: [index: number] }>();

const groups = computed(() => {
  const out = props.sections
    .map((s) => ({ id: s.id, title: s.title, items: props.items.filter((i) => i.sectionId === s.id) }))
    .filter((g) => g.items.length);
  const known = new Set(props.sections.map((s) => s.id));
  const rest = props.items.filter((i) => !known.has(i.sectionId));
  if (rest.length) out.push({ id: 0, title: 'Other', items: rest });
  return out;
});

const counts = computed(() => {
  const c: Record<PaletteStatus, number> = {
    answered: 0,
    'not-answered': 0,
    marked: 0,
    'answered-marked': 0,
    'not-visited': 0,
  };
  for (const i of props.items) c[i.status]++;
  return c;
});
</script>

<style scoped>
.group {
  margin-bottom: 12px;
}
.group-title {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
  gap: 6px;
}
.cell {
  height: 38px;
  border-radius: 6px;
  border: 1px solid var(--ion-color-medium);
  background: var(--ion-background-color, #fff);
  color: var(--ion-text-color, #000);
  font-weight: 600;
  cursor: pointer;
  position: relative;
}
.cell.small {
  display: inline-block;
  width: 18px;
  height: 18px;
  cursor: default;
}
.cell.current {
  outline: 3px solid var(--ion-color-primary);
  outline-offset: 1px;
}
.cell.answered {
  background: var(--ion-color-success);
  border-color: var(--ion-color-success);
  color: var(--ion-color-success-contrast);
}
.cell.not-answered {
  background: var(--ion-color-danger);
  border-color: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
}
.cell.marked {
  background: var(--ion-color-tertiary);
  border-color: var(--ion-color-tertiary);
  color: var(--ion-color-tertiary-contrast);
  border-radius: 50%;
}
.cell.answered-marked {
  background: var(--ion-color-tertiary);
  border-color: var(--ion-color-success);
  border-width: 3px;
  color: var(--ion-color-tertiary-contrast);
  border-radius: 50%;
}
.legend {
  display: grid;
  gap: 6px;
  font-size: 0.8rem;
  margin-top: 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
