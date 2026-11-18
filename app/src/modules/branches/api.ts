import { api } from '@/core/api';

export interface Branch {
  id: number;
  name: string;
  code: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  status: 'active' | 'closed';
}
export type BranchInput = Omit<Branch, 'id' | 'status'> & { status?: Branch['status'] };
/** Status changes go through `close`/`activate`, never a plain update. */
export type BranchUpdate = Partial<Omit<BranchInput, 'status'>>;

export const branchesApi = {
  list: () => api.get<Branch[]>('/branches'),
  create: (b: BranchInput) => api.post<Branch>('/branches', b),
  update: (id: number, b: BranchUpdate) => api.patch<Branch>(`/branches/${id}`, b),
  remove: (id: number) => api.delete(`/branches/${id}`),
  /** Closing keeps the branch's history but frees its plan slot; blocked while it has active students. */
  close: (id: number, reason?: string) => api.post<Branch>(`/branches/${id}/close`, { reason }),
  activate: (id: number) => api.post<Branch>(`/branches/${id}/activate`, {}),
};
