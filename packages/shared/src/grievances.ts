/** Grievance & complaint management (spec §4.15). */

export const GRIEVANCE_STATUSES = ['open', 'in_progress', 'escalated', 'resolved', 'closed'] as const;
export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

export const GRIEVANCE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type GrievancePriority = (typeof GRIEVANCE_PRIORITIES)[number];

export type GrievanceRequesterType = 'student' | 'parent' | 'staff';

/** Statuses from which a ticket may move to each target status (staff transitions). */
export const GRIEVANCE_TRANSITIONS: Record<GrievanceStatus, readonly GrievanceStatus[]> = {
  open: ['in_progress', 'escalated', 'resolved', 'closed'],
  in_progress: ['escalated', 'resolved', 'closed'],
  escalated: ['in_progress', 'resolved', 'closed'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

export type GrievanceActivityType =
  'reply' | 'internal_note' | 'status_change' | 'assignment' | 'escalation' | 'system';

export interface GrievanceCategoryDto {
  id: number;
  name: string;
  description: string | null;
  defaultAssigneeUserId: number | null;
  defaultAssigneeName?: string | null;
  slaHours: number;
  isActive: boolean;
}

export interface GrievanceCategoryInput {
  name: string;
  description?: string | null;
  defaultAssigneeUserId?: number | null;
  slaHours?: number;
  isActive?: boolean;
}

export interface GrievanceSettingsDto {
  ticketPrefix: string;
  defaultSlaHours: number;
  escalationUserId: number | null;
}

export interface GrievanceUserRef {
  id: number;
  name: string;
}

export interface GrievanceTicketDto {
  id: number;
  ticketNumber: string;
  branchId: number | null;
  categoryId: number;
  categoryName: string | null;
  subject: string;
  description: string;
  priority: GrievancePriority;
  status: GrievanceStatus;
  requesterType: GrievanceRequesterType;
  requester: GrievanceUserRef | null;
  onBehalfOf: GrievanceUserRef | null;
  assignee: GrievanceUserRef | null;
  dueAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  escalatedAt: string | null;
  escalationLevel: number;
  slaBreached: boolean;
  reopenCount: number;
  resolutionNotes: string | null;
  closureConfirmed: boolean | null;
  satisfactionRating: number | null;
  closureFeedback: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrievanceAttachmentDto {
  id: number;
  fileId: number;
  commentId: number | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  isInternal: boolean;
  createdAt: string;
}

export interface GrievanceActivityDto {
  id: number;
  type: GrievanceActivityType;
  isInternal: boolean;
  body: string | null;
  author: GrievanceUserRef | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface GrievanceTicketDetailDto extends GrievanceTicketDto {
  activities: GrievanceActivityDto[];
  attachments: GrievanceAttachmentDto[];
  /** Whether the caller acts as staff (queue handler) on this ticket. */
  canManage: boolean;
}

export interface CreateGrievanceInput {
  categoryId: number;
  subject: string;
  description: string;
  priority?: GrievancePriority;
  branchId?: number | null;
  /** Parent filing on behalf of a linked child (student user id). */
  onBehalfOfUserId?: number | null;
}

export interface GrievanceReportSummary {
  from: string | null;
  to: string | null;
  total: number;
  byStatus: Record<GrievanceStatus, number>;
  byPriority: Record<GrievancePriority, number>;
  byCategory: { categoryId: number; name: string; total: number; avgResolutionHours: number | null }[];
  avgFirstResponseHours: number | null;
  avgResolutionHours: number | null;
  slaBreached: number;
  slaComplianceRate: number | null;
  reopened: number;
  avgSatisfaction: number | null;
}
