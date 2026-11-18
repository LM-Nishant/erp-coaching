import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { IonicVue } from '@ionic/vue';

import '@ionic/vue/css/core.css';
import '@ionic/vue/css/normalize.css';
import '@ionic/vue/css/structure.css';
import '@ionic/vue/css/typography.css';
import '@ionic/vue/css/padding.css';
import '@ionic/vue/css/float-elements.css';
import '@ionic/vue/css/text-alignment.css';
import '@ionic/vue/css/text-transformation.css';
import '@ionic/vue/css/flex-utils.css';
import '@ionic/vue/css/display.css';
import '@ionic/vue/css/palettes/dark.system.css';
import './theme/variables.css';

import App from './App.vue';
import { router } from './router';
import { vCan } from './core/permissions';
import { installSession } from './core/session';
import { initSecureScreen } from './core/secure-screen';

const app = createApp(App).use(IonicVue).use(createPinia());
// Before the router: installing it starts the first navigation, which restores the session.
installSession(router);
initSecureScreen();
app.use(router).directive('can', vCan);

router.isReady().then(() => app.mount('#app'));
