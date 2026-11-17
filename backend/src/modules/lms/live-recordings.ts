import { UniqueConstraintError } from 'sequelize';
import { requireTenantContext } from '../../shared/context';
import { Batch, CourseSubject } from '../academics/api';
import type { LiveRecordingReadyEvent } from '../live-classes/api';
import { LmsResource } from './models';
import { createResource, setResourceStatus } from './resources.service';

export const liveRecordingSourceRef = (recordingId: number) => `live-recording:${recordingId}`;

/**
 * Publishes a live class recording as an LMS resource on the class's course/subject, restricted
 * to its batch. Idempotent through `sourceRef` (unique per institute). Skips classes with no course.
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
        type: e.mimeType.startsWith('video/') ? 'video' : 'document',
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
  return LmsResource.findOne({ where: { instituteId, id } });
}
