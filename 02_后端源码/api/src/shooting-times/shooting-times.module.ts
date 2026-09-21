import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ShootingTimesController } from './shooting-times.controller';
import { ShootingTimesService } from './shooting-times.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ShootingTimesController],
  providers: [ShootingTimesService],
})
export class ShootingTimesModule {}
