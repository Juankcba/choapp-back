import { Global, Module } from '@nestjs/common';
import { FieldEncryptionService } from './field-encryption.service';

// Global para que cualquier módulo pueda inyectar FieldEncryptionService
// sin tener que importar CommonModule en cada `imports`. Los sites que leen
// datos de Service (admin, matching, payments, mail) lo necesitan.
@Global()
@Module({
    providers: [FieldEncryptionService],
    exports: [FieldEncryptionService],
})
export class CommonModule { }
