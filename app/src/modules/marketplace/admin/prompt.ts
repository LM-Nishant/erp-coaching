import { alertController } from '@ionic/vue';

/** A one-field prompt; resolves to the trimmed text, or null when cancelled. */
export async function promptText(
  header: string,
  opts: { message?: string; placeholder?: string; value?: string; confirm?: string } = {},
): Promise<string | null> {
  const alert = await alertController.create({
    header,
    message: opts.message,
    inputs: [{ name: 'v', type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '' }],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: opts.confirm ?? 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { v: string } }>();
  return role === 'confirm' ? (data?.values.v ?? '').trim() : null;
}

/** A yes/no confirmation. */
export async function confirmAction(header: string, message: string, confirm = 'Confirm'): Promise<boolean> {
  const alert = await alertController.create({
    header,
    message,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: confirm, role: 'confirm' },
    ],
  });
  await alert.present();
  return (await alert.onDidDismiss()).role === 'confirm';
}
