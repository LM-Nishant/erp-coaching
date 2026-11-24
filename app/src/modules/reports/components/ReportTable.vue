<template>
  <section class="report-table">
    <h3 v-if="showTitle">{{ table.title }}</h3>
    <p v-if="!table.rows.length" class="muted">{{ t('reports.table.empty') }}</p>
    <div v-else class="scroll">
      <table>
        <thead>
          <tr>
            <th v-for="c in table.columns" :key="c.key" :class="{ num: isNumericType(c.type) }">
              {{ c.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in table.rows" :key="i">
            <td v-for="c in table.columns" :key="c.key" :class="{ num: isNumericType(c.type) }">
              {{ formatValue(row[c.key], c.type, timezone) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="table.rows.length < table.totalRows" class="muted note">
      {{
        t('reports.table.truncated', {
          shown: formatNumber(table.rows.length),
          total: formatNumber(table.totalRows),
        })
      }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ReportTableDto } from '@erp/shared';
import { formatNumber } from '@/core/format';
import { formatValue, isNumericType } from '../format';

const { t } = useI18n();

withDefaults(defineProps<{ table: ReportTableDto; timezone: string; showTitle?: boolean }>(), {
  showTitle: true,
});
</script>

<style scoped>
.report-table {
  margin: 16px 0;
}
h3 {
  font-size: 16px;
  margin: 0 0 8px;
}
.scroll {
  overflow-x: auto;
  border: 1px solid var(--ion-color-light-shade, #ddd);
  border-radius: 8px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  padding: 8px 10px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--ion-color-light-shade, #eee);
}
th {
  background: var(--ion-color-light, #f4f5f8);
  font-weight: 600;
}
tbody tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.note {
  font-size: 12px;
  margin: 6px 0 0;
}
</style>
