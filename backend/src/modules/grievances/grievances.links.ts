import type { GrievanceUserRef } from '@erp/shared';

/**
 * Returns the student users linked to a parent. The students module owns guardian links; it
 * registers the real resolver with `setLinkedStudentsResolver()` (e.g. from its `onReady`).
 * Until then parents can only file complaints for themselves.
 */
export type LinkedStudentsResolver = (
  parentUserId: number,
  instituteId: number,
) => Promise<GrievanceUserRef[]>;

let resolver: LinkedStudentsResolver = async () => [];

export function setLinkedStudentsResolver(fn: LinkedStudentsResolver): void {
  resolver = fn;
}

export function getLinkedStudents(parentUserId: number, instituteId: number): Promise<GrievanceUserRef[]> {
  return resolver(parentUserId, instituteId);
}
