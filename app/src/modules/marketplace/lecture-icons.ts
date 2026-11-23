import {
  documentAttachOutline,
  documentTextOutline,
  helpCircleOutline,
  playCircleOutline,
} from 'ionicons/icons';

/** Icon per lecture type; unknown types (e.g. quizzes added later) get a generic one. */
export const lectureIcon = (type: string) =>
  ({ video: playCircleOutline, article: documentTextOutline, resource: documentAttachOutline })[type] ??
  helpCircleOutline;
