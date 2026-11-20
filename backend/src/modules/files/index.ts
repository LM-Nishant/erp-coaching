import { defineModule } from '../../shared/module';
import { FileObject } from './file.model';
import { fileRoutes } from './files.routes';

export default defineModule({
  name: 'files',
  models: (sequelize) => FileObject.initModel(sequelize),
  routes: fileRoutes,
  permissions: [
    {
      module: 'files',
      label: 'Files & uploads',
      area: 'Reports & files',
      describe: {
        view: ['View files', 'Open uploaded documents and attachments'],
        create: ['Upload files', 'Upload documents, photos and attachments'],
        delete: ['Delete files', 'Remove uploaded files'],
      },
      actions: ['view', 'create', 'delete'],
      grants: {
        'branch-admin': 'all',
        accountant: ['view', 'create'],
        teacher: ['view', 'create'],
        student: ['view'],
        parent: ['view'],
      },
    },
  ],
});
