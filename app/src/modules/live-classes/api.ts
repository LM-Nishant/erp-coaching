import type {
  CreateLiveSessionInput,
  LiveChatMessageDto,
  LiveJoinInfo,
  LiveParticipantDto,
  LivePollDto,
  LiveQuestionDto,
  LiveRecordingDto,
  LiveRecordingUrlDto,
  LiveSessionDto,
  LiveSessionStatus,
  Paginated,
  UpdateLiveSessionInput,
} from '@erp/shared';
import { api } from '@/core/api';

const base = '/live-classes';

export interface ParticipationReport {
  participants: LiveParticipantDto[];
  absent: { id: number; name: string }[];
  enrolledStudents: number;
  joinedStudents: number;
}

export const liveApi = {
  list: (
    q: {
      page?: number;
      pageSize?: number;
      status?: LiveSessionStatus[];
      batchId?: number;
      upcoming?: boolean;
    } = {},
  ) =>
    api.get<Paginated<LiveSessionDto>>(base, {
      page: q.page,
      pageSize: q.pageSize ?? 50,
      status: q.status?.join(','),
      batchId: q.batchId,
      upcoming: q.upcoming || undefined,
    }),
  get: (id: number) => api.get<LiveSessionDto>(`${base}/${id}`),
  create: (b: CreateLiveSessionInput) => api.post<LiveSessionDto>(base, b),
  update: (id: number, b: UpdateLiveSessionInput) => api.patch<LiveSessionDto>(`${base}/${id}`, b),
  cancel: (id: number) => api.post<LiveSessionDto>(`${base}/${id}/cancel`),
  remove: (id: number) => api.delete(`${base}/${id}`),
  start: (id: number) => api.post<LiveSessionDto>(`${base}/${id}/start`),
  end: (id: number) => api.post<LiveSessionDto>(`${base}/${id}/end`),
  join: (id: number) => api.post<LiveJoinInfo>(`${base}/${id}/join`),
  participants: (id: number) => api.get<ParticipationReport>(`${base}/${id}/participants`),
  chat: (id: number) => api.get<LiveChatMessageDto[]>(`${base}/${id}/chat`),
  questions: (id: number) => api.get<LiveQuestionDto[]>(`${base}/${id}/questions`),
  polls: (id: number) => api.get<LivePollDto[]>(`${base}/${id}/polls`),
  recordings: (q: { liveSessionId?: number; batchId?: number } = {}) =>
    api.get<LiveRecordingDto[]>(`${base}/recordings`, q),
  /** `hls` falls back to the recording file until its HLS copy is ready. */
  recordingUrl: (id: number, format: 'hls' | 'file' = 'file') =>
    api.get<LiveRecordingUrlDto>(`${base}/recordings/${id}/url`, { format }),
  uploadRecording: (id: number, blob: Blob, durationSeconds: number) => {
    const form = new FormData();
    form.append('durationSeconds', String(Math.round(durationSeconds)));
    // MediaRecorder types carry codec parameters (`video/webm;codecs=vp9,opus`) that multipart parsers mangle.
    const type = blob.type.split(';')[0] || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    form.append('file', new Blob([blob], { type }), `live-${id}-${Date.now()}.${ext}`);
    return api.post<LiveRecordingDto>(`${base}/${id}/recordings`, form);
  },
};
