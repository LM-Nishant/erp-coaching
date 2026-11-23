import type {
  DoubtBox,
  DoubtCountsDto,
  DoubtDetailDto,
  DoubtDto,
  DoubtOptionsDto,
  DoubtStatus,
  Paginated,
} from '@erp/shared';
import { api } from '@/core/api';

export interface AskDoubtForm {
  question: string;
  batchId?: number | null;
  subjectId?: number | null;
  lectureId?: number | null;
  positionSeconds?: number | null;
  liveClassId?: number | null;
  photo?: Blob | null;
}

function toForm(fields: Record<string, string | number | null | undefined>, photo?: Blob | null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== '') form.append(k, String(v));
  if (photo) form.append('file', photo, (photo as File).name || 'photo.jpg');
  return form;
}

export const doubtsApi = {
  list: (q: { box: DoubtBox; status?: DoubtStatus; page?: number; pageSize?: number }) =>
    api.get<Paginated<DoubtDto>>('/doubts', q),
  counts: () => api.get<DoubtCountsDto>('/doubts/counts'),
  options: () => api.get<DoubtOptionsDto>('/doubts/options'),
  get: (id: number) => api.get<DoubtDetailDto>(`/doubts/${id}`),
  ask: ({ photo, ...fields }: AskDoubtForm) => api.post<DoubtDetailDto>('/doubts', toForm({ ...fields }, photo)),
  reply: (id: number, body: string, photo?: Blob | null) =>
    api.post<DoubtDetailDto>(`/doubts/${id}/replies`, toForm({ body }, photo)),
  resolve: (id: number) => api.post<DoubtDetailDto>(`/doubts/${id}/resolve`),
};

/** `12:05` / `1:02:05`: the video position a doubt was asked at. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const STATUS_TONE: Record<DoubtStatus, 'warning' | 'success' | 'medium'> = {
  open: 'warning',
  answered: 'success',
  resolved: 'medium',
};
