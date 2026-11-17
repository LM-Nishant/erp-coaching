<template>
  <AppPage :title="child?.name ?? 'Child'" back-href="/my-children" :on-refresh="load">
    <template v-if="child">
      <ion-card>
        <ion-card-header>
          <ion-card-title
            >{{ child.name }}
            <ion-badge :color="STATUS_COLORS[child.status]">{{ child.status }}</ion-badge></ion-card-title
          >
          <ion-card-subtitle
            >{{ child.admissionNumber
            }}<span v-if="child.rollNumber"> · Roll {{ child.rollNumber }}</span></ion-card-subtitle
          >
        </ion-card-header>
        <ion-card-content>
          <p>
            📱 {{ child.mobile }}<span v-if="child.email"> · {{ child.email }}</span>
          </p>
          <p v-if="child.dateOfBirth">DOB {{ child.dateOfBirth }}</p>
          <p v-if="child.academicInfo">
            {{
              [child.academicInfo.schoolName, child.academicInfo.classGrade, child.academicInfo.targetExam]
                .filter(Boolean)
                .join(' · ')
            }}
          </p>
          <p class="muted">Admitted {{ fmtDate(child.admittedAt) }}</p>
        </ion-card-content>
      </ion-card>

      <ion-list>
        <ion-list-header><ion-label>Guardians</ion-label></ion-list-header>
        <ion-item v-for="g in child.guardians" :key="g.linkId">
          <ion-label
            >{{ g.name }} · {{ humanize(g.relation) }}<span v-if="g.isPrimary"> (primary)</span></ion-label
          >
        </ion-item>
      </ion-list>

      <ion-list v-if="child.academicRecords.length">
        <ion-list-header><ion-label>Academic history</ion-label></ion-list-header>
        <ion-item v-for="r in child.academicRecords" :key="r.id">
          <ion-label>
            <h3>{{ [r.classGrade, r.institution].filter(Boolean).join(' · ') }}</h3>
            <p>
              {{
                [r.academicYear, r.board, r.result, r.percentage != null ? `${r.percentage}%` : null]
                  .filter(Boolean)
                  .join(' · ')
              }}
            </p>
          </ion-label>
        </ion-item>
      </ion-list>

      <ion-list v-if="child.documents.length">
        <ion-list-header><ion-label>Documents</ion-label></ion-list-header>
        <ion-item v-for="d in child.documents" :key="d.id">
          <ion-label
            ><a :href="d.url" target="_blank" rel="noopener">{{ d.title || d.originalName }}</a> ·
            {{ humanize(d.docType) }}</ion-label
          >
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
} from '@ionic/vue';
import type { StudentProfileDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { STATUS_COLORS, fmtDate, humanize } from '@/modules/students/api';
import { guardianPortalApi } from './api';

const route = useRoute();
const router = useRouter();
const child = ref<StudentProfileDto | null>(null);

async function load() {
  try {
    child.value = await guardianPortalApi.child(Number(route.params.id));
  } catch (e) {
    await toastError(e);
    await router.replace('/my-children');
  }
}

onMounted(load);
</script>
