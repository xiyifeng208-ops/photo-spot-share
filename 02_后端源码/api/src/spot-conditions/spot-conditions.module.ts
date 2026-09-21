import { Module } from '@nestjs/common';
import { SpotConditionsController } from './spot-conditions.controller';
import { SpotConditionsService } from './spot-conditions.service';

@Module({ controllers: [SpotConditionsController], providers: [SpotConditionsService] })
export class SpotConditionsModule {}
