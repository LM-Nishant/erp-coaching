import { defineAsyncComponent } from 'vue';
import { chatbubblesOutline, clipboardOutline, documentTextOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'admissions',
  routes: [
    {
      path: '/admissions/enquiries',
      name: 'enquiries',
      component: () => import('./EnquiriesPage.vue'),
      meta: { permission: 'admissions.view' },
    },
    {
      path: '/admissions/applications',
      name: 'applications',
      component: () => import('./ApplicationsPage.vue'),
      meta: { permission: 'admissions.view' },
    },
    {
      path: '/admissions/forms',
      name: 'admission-forms',
      component: () => import('./FormsPage.vue'),
      meta: { permission: 'admissions.configure' },
    },
  ],
  widgets: [
    {
      id: 'admissions.today',
      slot: 'staff-home',
      title: 'admissions.today.title',
      component: defineAsyncComponent(() => import('./EnquiriesTodayCard.vue')),
      permission: 'admissions.view',
      planModule: 'admissions',
      order: 20,
    },
  ],
  menu: [
    {
      title: 'Enquiries',
      path: '/admissions/enquiries',
      group: 'people',
      titleKey: 'nav.admissions.enquiries',
      tab: { staff: 5 },
      icon: chatbubblesOutline,
      permission: 'admissions.view',
      order: 25,
    },
    {
      title: 'Applications',
      path: '/admissions/applications',
      group: 'people',
      titleKey: 'nav.admissions.applications',
      icon: clipboardOutline,
      permission: 'admissions.view',
      order: 26,
    },
    {
      title: 'Admission forms',
      path: '/admissions/forms',
      group: 'people',
      titleKey: 'nav.admissions.forms',
      icon: documentTextOutline,
      permission: 'admissions.configure',
      order: 27,
    },
  ],
});
