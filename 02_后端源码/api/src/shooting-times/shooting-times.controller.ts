import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../common/guards/jwt-auth.guard';
import { ShootingTimesService } from './shooting-times.service';

@Public()
@Controller('spots')
export class ShootingTimesController {
  constructor(private readonly shootingTimes: ShootingTimesService) {}

  @Get(':id/shooting-times')
  get(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Query('date') date?: unknown,
  ) {
    return this.shootingTimes.getForSpot(id, date);
  }
}
