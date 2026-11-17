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

export const branchesApi = {
  list: () => api.get<Branch[]>('/branches'),
  create: (b: BranchInput) => api.post<Branch>('/branches', b),
  update: (id: number, b: Partial<BranchInput>) => api.patch<Branch>(`/branches/${id}`, b),
  remove: (id: number) => api.delete(`/branches/${id}`),
};
