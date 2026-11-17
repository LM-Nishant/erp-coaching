<template>
  <ion-page>
    <ion-content class="ion-padding">
      <div class="auth-wrap">
        <div class="logo">
          <img src="/favicon.svg" alt="" />
          <h1>{{ info?.institute.name ?? 'Student registration' }}</h1>
          <p class="muted">Create your student account</p>
        </div>

        <ion-spinner v-if="loading" />
        <ion-text v-else-if="loadError" color="danger"
          ><p>{{ loadError }}</p></ion-text
        >
        <ion-card v-else-if="info && !info.enabled">
          <ion-card-content
            >Self-registration is currently closed. Please contact the institute.</ion-card-content
          >
        </ion-card>

        <ion-card v-else-if="result">
          <ion-card-header><ion-card-title>You're registered 🎉</ion-card-title></ion-card-header>
          <ion-card-content>
            <p>
              Admission number: <strong>{{ result.admissionNumber }}</strong>
            </p>
            <p v-if="result.rollNumber">
              Roll number: <strong>{{ result.rollNumber }}</strong>
            </p>
            <p>
              Your account is active.
              {{
                result.hasPassword
                  ? 'Sign in with your mobile and password.'
                  : 'Sign in with your mobile number using OTP.'
              }}
            </p>
            <ion-button expand="block" router-link="/login">Go to sign in</ion-button>
          </ion-card-content>
        </ion-card>

        <form v-else-if="info" @submit.prevent="submit">
          <ion-list lines="full" class="form-card">
            <ion-item
              ><ion-input
                v-model="f.name"
                label="Full name *"
                label-placement="stacked"
                autocomplete="name"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="f.mobile"
                label="Mobile *"
                label-placement="stacked"
                type="tel"
                autocomplete="tel"
                required
            /></ion-item>
            <ion-item>
              <ion-input
                v-model="f.password"
                label="Password (optional)"
                label-placement="stacked"
                type="password"
                autocomplete="new-password"
                helper-text="Leave blank to sign in with OTP. If you already have an account, enter its password."
              >
                <ion-input-password-toggle slot="end" />
              </ion-input>
            </ion-item>
            <ion-item
              ><ion-input
                v-model="f.email"
                label="Email"
                label-placement="stacked"
                type="email"
                autocomplete="email"
            /></ion-item>
            <ion-item v-if="info.branches.length > 1">
              <ion-select v-model="f.branchId" label="Branch" label-placement="stacked" interface="popover">
                <ion-select-option v-for="b in info.branches" :key="b.id" :value="b.id">{{
                  b.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>

          <ion-accordion-group>
            <ion-accordion value="more">
              <ion-item slot="header"><ion-label>More details (optional)</ion-label></ion-item>
              <ion-list slot="content" lines="full">
                <ion-item
                  ><ion-input
                    v-model="f.dateOfBirth"
                    label="Date of birth"
                    label-placement="stacked"
                    type="date"
                /></ion-item>
                <ion-item>
                  <ion-select v-model="f.gender" label="Gender" label-placement="stacked" interface="popover">
                    <ion-select-option value="male">Male</ion-select-option>
                    <ion-select-option value="female">Female</ion-select-option>
                    <ion-select-option value="other">Other</ion-select-option>
                  </ion-select>
                </ion-item>
                <ion-item
                  ><ion-input v-model="f.schoolName" label="School / college" label-placement="stacked"
                /></ion-item>
                <ion-item
                  ><ion-input v-model="f.classGrade" label="Class / grade" label-placement="stacked"
                /></ion-item>
                <ion-item
                  ><ion-input v-model="f.targetExam" label="Target exam" label-placement="stacked"
                /></ion-item>
                <ion-item
                  ><ion-input v-model="f.parentName" label="Parent / guardian name" label-placement="stacked"
                /></ion-item>
                <ion-item
                  ><ion-input
                    v-model="f.parentMobile"
                    label="Parent / guardian mobile"
                    label-placement="stacked"
                    type="tel"
                /></ion-item>
                <ion-item>
                  <ion-select
                    v-model="f.parentRelation"
                    label="Relation"
                    label-placement="stacked"
                    interface="popover"
                  >
                    <ion-select-option v-for="r in GUARDIAN_RELATIONS" :key="r" :value="r">{{
                      humanize(r)
                    }}</ion-select-option>
                  </ion-select>
                </ion-item>
                <CustomFieldsInput v-model="custom" :fields="info.fields" />
              </ion-list>
            </ion-accordion>
          </ion-accordion-group>

          <ion-text v-if="error" color="danger"
            ><p class="error">{{ error }}</p></ion-text
          >
          <ion-button expand="block" type="submit" :disabled="submitting">
            <ion-spinner v-if="submitting" name="crescent" />
            <span v-else>Register</span>
          </ion-button>
          <p class="muted ion-text-center">Documents can be uploaded from your profile after signing in.</p>
        </form>
        <p class="ion-text-center"><router-link to="/login">Already registered? Sign in</router-link></p>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonAccordion,
  IonAccordionGroup,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonInput,
  IonInputPasswordToggle,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonText,
} from '@ionic/vue';
import {
  GUARDIAN_RELATIONS,
  type GuardianRelation,
  type SelfRegistrationInfo,
  type SelfRegistrationResult,
} from '@erp/shared';
import { ApiError, errorMessage } from '@/core/api';
import CustomFieldsInput from './CustomFieldsInput.vue';
import { humanize, registrationApi } from './api';

const route = useRoute();
const slug = String(route.params.slug);
const info = ref<SelfRegistrationInfo | null>(null);
const loading = ref(true);
const loadError = ref('');
const submitting = ref(false);
const error = ref('');
const result = ref<SelfRegistrationResult | null>(null);
const custom = ref<Record<string, unknown>>({});
const f = reactive({
  name: '',
  mobile: '',
  password: '',
  email: '',
  branchId: undefined as number | undefined,
  dateOfBirth: '',
  gender: null as 'male' | 'female' | 'other' | null,
  schoolName: '',
  classGrade: '',
  targetExam: '',
  parentName: '',
  parentMobile: '',
  parentRelation: 'father' as GuardianRelation,
});

const orNull = (v: string) => (v.trim() ? v.trim() : null);

const MESSAGES: Record<string, string> = {
  ACCOUNT_EXISTS: 'An account with this mobile already exists. Enter its password to register, or sign in.',
  ALREADY_REGISTERED: 'You are already registered with this institute. Please sign in.',
  SELF_REGISTRATION_DISABLED: 'Self-registration is currently closed.',
};

async function submit() {
  error.value = '';
  if ((f.parentName && !f.parentMobile) || (!f.parentName && f.parentMobile)) {
    error.value = 'Enter both parent name and mobile, or leave both blank.';
    return;
  }
  submitting.value = true;
  try {
    const hasAcademic = f.schoolName || f.classGrade || f.targetExam;
    result.value = await registrationApi.register(slug, {
      name: f.name.trim(),
      mobile: f.mobile.trim(),
      password: f.password || undefined,
      email: orNull(f.email),
      branchId: f.branchId,
      dateOfBirth: orNull(f.dateOfBirth),
      gender: f.gender,
      academicInfo: hasAcademic
        ? {
            schoolName: orNull(f.schoolName),
            classGrade: orNull(f.classGrade),
            targetExam: orNull(f.targetExam),
          }
        : null,
      parent: f.parentName
        ? { name: f.parentName.trim(), mobile: f.parentMobile.trim(), relation: f.parentRelation }
        : null,
      customFields: custom.value,
    });
  } catch (e) {
    error.value = e instanceof ApiError && MESSAGES[e.code] ? MESSAGES[e.code]! : errorMessage(e);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    info.value = await registrationApi.info(slug);
  } catch (e) {
    loadError.value = e instanceof ApiError && e.status === 404 ? 'Institute not found.' : errorMessage(e);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.auth-wrap {
  max-width: 480px;
  margin: 6vh auto 0;
}
.logo {
  text-align: center;
  margin-bottom: 24px;
}
.logo img {
  width: 64px;
}
.logo h1 {
  margin: 8px 0 0;
}
.error {
  white-space: pre-line;
  font-size: 14px;
}
</style>
