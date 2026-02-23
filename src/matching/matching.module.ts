import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingGateway } from './matching.gateway';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [UsersModule],
    providers: [MatchingService, MatchingGateway],
    exports: [MatchingService, MatchingGateway],
})
export class MatchingModule { }
