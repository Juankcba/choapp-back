import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingGateway } from './matching.gateway';

@Module({
    providers: [MatchingService, MatchingGateway],
    exports: [MatchingService, MatchingGateway],
})
export class MatchingModule { }
