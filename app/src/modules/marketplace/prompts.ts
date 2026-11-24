import { alertController } from '@ionic/vue';

/** Asks for one line of text; resolves to the trimmed text, or null when cancelled or left empty. */
export async function promptText(opts: {
  header: string;
  message?: string;
  placeholder?: string;
  confirm?: string;
  maxlength?: number;
}): Promise<string | null> {
  const alert = await alertController.create({
    header: opts.header,
    message: opts.message,
    inputs: [
      { name: 'text', placeholder: opts.placeholder, attributes: { maxlength: opts.maxlength ?? 500 } },
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: opts.confirm ?? 'OK', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { text: string } }>();
  const text = data?.values.text?.trim();
  return role === 'confirm' && text ? text : null;
}

/** Yes/no confirmation; resolves true when confirmed. */
export async function confirmAction(header: string, message: string, confirm = 'Delete'): Promise<boolean> {
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
