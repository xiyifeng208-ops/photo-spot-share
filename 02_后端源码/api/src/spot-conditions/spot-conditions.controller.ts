import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public, type RequestUser } from '../common/guards/jwt-auth.guard';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { ListFeedbackDto, PutFeedbackDto } from './spot-conditions.dto';
import { SpotConditionsService } from './spot-conditions.service';

@Controller('spots')
export class SpotConditionsController {
  constructor(private readonly conditions: SpotConditionsService) {}

  @Public()
  @Get(':id/feedback')
  list(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Query() query: ListFeedbackDto,
    @CurrentUser(false) user?: RequestUser,
  ) { return this.conditions.list(id, user?.id, query.cursor, query.limit); }

  @Put(':id/feedback')
  @RateLimit({ scope: 'user-and-route', limit: 20, windowMs: 60 * 60 * 1000 })
  put(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @CurrentUser() user: RequestUser,
    @Body() body: PutFeedbackDto,
  ) { return this.conditions.put(id, user.id, body.kind); }

  @Delete(':id/feedback')
  remove(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @CurrentUser() user: RequestUser,
  ) { return this.conditions.remove(id, user.id); }
}

