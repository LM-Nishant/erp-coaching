import { toastController } from '@ionic/vue';
import { errorMessage } from './api';

export async function toast(message: string, color: 'success' | 'danger' | 'medium' | 'warning' = 'success') {
  const t = await toastController.create({
    message,
    color,
    duration: color === 'danger' ? 4000 : 2000,
    position: 'top',
  });
  await t.present();
}

export const toastError = (e: unknown) => toast(errorMessage(e), 'danger');
