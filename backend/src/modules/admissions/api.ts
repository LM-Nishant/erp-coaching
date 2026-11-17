/** Public cross-module API of the admissions module. Import from here, not from internal files. */
export {
  onAdmissionCompleted,
  type AdmissionCompletedEvent,
  type AdmissionCompletedListener,
} from './admission-events';
