import { chatbubblesOutline, fileTrayFullOutline, settingsOutline, statsChartOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'grievances',
  routes: [
    {
      path: '/grievances',
      name: 'grievances-queue',
      component: () => import('./GrievanceQueuePage.vue'),
      meta: { permission: 'grievances.edit' },
    },
    {
      path: '/grievances/my',
      name: 'grievances-mine',
      component: () => import('./MyComplaintsPage.vue'),
      meta: { permission: 'grievances.create' },
    },
    {
      path: '/grievances/new',
      name: 'grievances-new',
      component: () => import('./NewComplaintPage.vue'),
      meta: { permission: 'grievances.create' },
    },
    {
      path: '/grievances/setup',
      name: 'grievances-setup',
      component: () => import('./GrievanceSetupPage.vue'),
      meta: { permission: 'grievances.configure' },
    },
    {
      path: '/grievances/reports',
      name: 'grievances-reports',
      component: () => import('./GrievanceReportsPage.vue'),
      meta: { permission: 'grievances.export' },
    },
    {
      path: '/grievances/:id(\\d+)',
      name: 'grievance-detail',
      component: () => import('./GrievanceDetailPage.vue'),
      meta: { permission: 'grievances.view' },
    },
  ],
  menu: [
    {
      title: 'Complaint queue',
      path: '/grievances',
      icon: fileTrayFullOutline,
      permission: 'grievances.edit',
      planModule: 'grievances',
      order: 70,
    },
    {
      title: 'My complaints',
      path: '/grievances/my',
      icon: chatbubblesOutline,
      permission: 'grievances.create',
      planModule: 'grievances',
      order: 71,
    },
    {
      title: 'Grievance reports',
      path: '/grievances/reports',
      icon: statsChartOutline,
      permission: 'grievances.export',
      planModule: 'grievances',
      order: 72,
    },
    {
      title: 'Grievance setup',
      path: '/grievances/setup',
      icon: settingsOutline,
      permission: 'grievances.configure',
      planModule: 'grievances',
      order: 73,
    },
  ],
});
