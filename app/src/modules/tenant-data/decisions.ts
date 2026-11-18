import { alertController, type AlertInput } from '@ionic/vue';
import type { DeletionRequestDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { DEFAULT_GRACE_DAYS, deletionAdminApi } from './api';

type Values = Record<string, string | undefined>;

/** Shows a confirmation alert; resolves to the input values, or null when dismissed. */
async function ask(opts: {
  header: string;
  message: string;
  confirm: string;
  destructive?: boolean;
  inputs?: AlertInput[];
  validate?: (values: Values) => string | null;
}): Promise<Values | null> {
  const confirmRole = opts.destructive ? 'destructive' : 'confirm';
  const alert = await alertController.create({
    header: opts.header,
    message: opts.message,
    inputs: opts.inputs,
    buttons: [
      { text: 'Back', role: 'cancel' },
      {
        text: opts.confirm,
        role: confirmRole,
        handler: (values: Values) => {
          const problem = opts.validate?.(values ?? {});
          if (problem) {
            void toast(problem, 'warning');
            return false;
          }
          return true;
        },
      },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values?: Values }>();
  return role === confirmRole ? (data?.values ?? {}) : null;
}

const noteInput: AlertInput = {
  name: 'note',
  type: 'textarea',
  placeholder: 'Note (optional, kept in the audit log)',
  attributes: { maxlength: 1000 },
};
const noteOf = (v: Values) => v.note?.trim() || null;

async function run(action: () => Promise<DeletionRequestDto>, done: string) {
  try {
    const result = await action();
    await toast(done);
    return result;
  } catch (e) {
    await toastError(e);
    return null;
  }
}

/** Super admin decisions on a deletion request; each resolves to the updated request, or null. */
export async function approveDeletion(r: DeletionRequestDto): Promise<DeletionRequestDto | null> {
  const values = await ask({
    header: `Approve deleting ${r.instituteName}?`,
    message:
      'The institute is deactivated at once, so its users can no longer sign in. All of its data and files ' +
      'are permanently deleted when the grace period (days) ends, unless the request is cancelled first. ' +
      '0 deletes immediately.',
    confirm: 'Approve',
    destructive: true,
    inputs: [
      {
        name: 'graceDays',
        type: 'number',
        value: DEFAULT_GRACE_DAYS,
        min: 0,
        max: 365,
        placeholder: 'Grace period in days',
        attributes: { 'aria-label': 'Grace period in days' },
      },
      noteInput,
    ],
    validate: (v) => {
      const days = Number(v.graceDays);
      return v.graceDays?.trim() && Number.isInteger(days) && days >= 0 && days <= 365
        ? null
        : 'The grace period must be 0 to 365 days';
    },
  });
  if (!values) return null;
  const graceDays = Number(values.graceDays);
  if (graceDays === 0) {
    const now = await ask({
      header: 'Delete permanently now?',
      message: `Every record and file of ${r.instituteName} is deleted right away. This can't be undone.`,
      confirm: 'Delete now',
      destructive: true,
    });
    if (!now) return null;
  }
  return run(
    () => deletionAdminApi.approve(r.id, { graceDays, note: noteOf(values) }),
    graceDays === 0 ? 'Deletion started' : 'Deletion approved and scheduled',
  );
}

export async function rejectDeletion(r: DeletionRequestDto): Promise<DeletionRequestDto | null> {
  const values = await ask({
    header: `Reject the request for ${r.instituteName}?`,
    message: 'Nothing is deleted. The institute can raise a new request later.',
    confirm: 'Reject',
    inputs: [noteInput],
  });
  if (!values) return null;
  return run(() => deletionAdminApi.reject(r.id, { note: noteOf(values) }), 'Request rejected');
}

export async function cancelDeletion(r: DeletionRequestDto): Promise<DeletionRequestDto | null> {
  const values = await ask({
    header: `Cancel deleting ${r.instituteName}?`,
    message:
      r.status === 'approved'
        ? 'Nothing is deleted, and the institute is restored to the status it had before the approval.'
        : 'The request is closed without deleting anything.',
    confirm: 'Cancel deletion',
    inputs: [noteInput],
  });
  if (!values) return null;
  return run(() => deletionAdminApi.cancel(r.id, { note: noteOf(values) }), 'Deletion cancelled');
}

export async function retryDeletion(r: DeletionRequestDto): Promise<DeletionRequestDto | null> {
  const values = await ask({
    header: 'Retry the deletion?',
    message: `The permanent deletion of ${r.instituteName} continues where it stopped.`,
    confirm: 'Retry',
    destructive: true,
  });
  if (!values) return null;
  return run(() => deletionAdminApi.retry(r.id), 'Deletion restarted');
}
