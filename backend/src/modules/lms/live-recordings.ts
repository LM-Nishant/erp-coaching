import { UniqueConstraintError } from 'sequelize';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { Batch, CourseSubject } from '../academics/api';
import type { LiveRecordingReadyEvent } from '../live-classes/api';
import { LmsResource } from './models';
import { createResource, play, requestTranscode, setResourceStatus } from './resources.service';

export const liveRecordingSourceRef = (recordingId: number) => `live-recording:${recordingId}`;

/**
 * Publishes a live class recording as an LMS resource on the class's course/subject, restricted
 * to its batch, and queues its HLS rendition. Idempotent through `sourceRef` (unique per institute).
 * Skips classes with no course.
 */
export async function importLiveRecording(e: LiveRecordingReadyEvent): Promise<LmsResource | null> {
  const { instituteId } = requireTenantContext();
  const sourceRef = liveRecordingSourceRef(e.recordingId);
  const existing = await LmsResource.findOne({ where: { instituteId, sourceRef } });
  if (existing) {
    // A retry after the publish step failed; a teacher's later unpublish (publishedAt set) is kept.
    if (existing.status === 'draft' && !existing.publishedAt)
      await setResourceStatus(existing.id, 'published');
    return existing;
  }

  const batch = await Batch.findOne({
    where: { instituteId, id: e.batchId },
    attributes: ['id', 'courseId'],
  });
  const courseId = e.courseId ?? batch?.courseId ?? null;
  if (!courseId) return null;
  let subjectId = e.subjectId;
  if (subjectId) {
    const linked = await CourseSubject.count({ where: { instituteId, courseId } });
    if (linked && !(await CourseSubject.count({ where: { instituteId, courseId, subjectId } })))
      subjectId = null;
  }

  const type = e.mimeType.startsWith('video/') ? 'video' : 'document';
  let id: number;
  try {
    id = (
      await createResource({
        courseId,
        subjectId,
        branchId: e.branchId,
        batchIds: batch?.courseId === courseId ? [batch.id] : [],
        title: e.title.slice(0, 200),
        description: `Recording of the live class on ${e.recordedAt.slice(0, 10)}`,
        type,
        fileId: e.fileId,
        durationSeconds: e.durationSeconds,
        sourceRef,
      })
    ).id;
  } catch (err) {
    // A concurrent retry created it first.
    if (err instanceof UniqueConstraintError)
      return LmsResource.findOne({ where: { instituteId, sourceRef } });
    throw err;
  }
  await setResourceStatus(id, 'published');
  // Recorded classes stream as HLS like uploaded lectures (progressive MP4 until then, or without ffmpeg).
  if (type === 'video')
    await requestTranscode(id).catch((err: unknown) =>
      logger.warn({ err, resourceId: id }, 'Could not queue HLS transcoding of a live recording'),
    );
  return LmsResource.findOne({ where: { instituteId, id } });
}

/**
 * Signed HLS stream of a live recording's LMS video for the current user (live class pages), or
 * null while it has no HLS rendition or the LMS does not let this user stream it.
 */
export async function liveRecordingHls(
  recordingId: number,
): Promise<{ url: string; expiresAt: string } | null> {
  const { instituteId } = requireTenantContext();
  const r = await LmsResource.findOne({
    where: { instituteId, sourceRef: liveRecordingSourceRef(recordingId) },
    attributes: ['id', 'type', 'transcodeStatus', 'hlsPrefix'],
  });
  if (!r || r.type !== 'video' || r.transcodeStatus !== 'ready' || !r.hlsPrefix) return null;
  try {
    const p = await play(r.id, 'hls');
    return p.kind === 'hls' && p.expiresAt ? { url: p.url, expiresAt: p.expiresAt } : null;
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return null;
    throw err;
  }
}
