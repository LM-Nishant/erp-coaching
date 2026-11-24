import {
  checkboxOutline,
  documentAttachOutline,
  documentTextOutline,
  helpCircleOutline,
  playCircleOutline,
} from 'ionicons/icons';

/** Icon per lecture type; unknown types get a generic one. */
export const lectureIcon = (type: string) =>
  (
    ({
      video: playCircleOutline,
      article: documentTextOutline,
      resource: documentAttachOutline,
      quiz: checkboxOutline,
    }) as Record<string, string>
  )[type] ?? helpCircleOutline;
