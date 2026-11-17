import { registerExamsParentPortal } from './parent-portal';

/** Registers exams with provider modules; called from `onReady`. */
export function registerExamIntegrations(): void {
  registerExamsParentPortal();
}
