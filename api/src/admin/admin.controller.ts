import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AdminGuard } from '../common/guards/admin.guard';
import { Public } from '../common/guards/jwt-auth.guard';
import { ContentCheckTasksService } from '../spots/content-check-tasks.service';
import { ModerationService } from '../spots/moderation.service';

class SetStatusDto {
  @IsIn(['active', 'hidden', 'deleted'], { message: 'status 只能是 active / hidden / deleted' })
  status!: 'active' | 'hidden' | 'deleted';
}

class ResolveReportsDto {
  @IsIn(['resolved', 'rejected'], { message: 'resolution 只能是 resolved / rejected' })
  resolution!: 'resolved' | 'rejected';
}

/**
 * 极简运营接口（无界面）：查看举报、下线/恢复机位、手动触发机审兜底扫描。
 * 用 header `x-admin-token` 鉴权；不对外开放在小程序里。
 */
@Controller('admin')
@Public()
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly tasks: ContentCheckTasksService,
  ) {}

  @Get('reports')
  async listReports(@Query('status') status?: string, @Query('limit') limit?: string) {
    const items = await this.moderation.listReports(status ?? 'open', Number(limit) || 100);
    return { items, total: items.length };
  }

  @Post('spots/:id/status')
  async setSpotStatus(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: SetStatusDto,
  ) {
    await this.moderation.setStatus(id, dto.status);
    return { id, status: dto.status };
  }

  @Post('spots/:id/resolve-reports')
  async resolveReports(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: ResolveReportsDto,
  ) {
    const resolved = await this.moderation.resolveReports(id, dto.resolution);
    return { id, resolved };
  }

  /** 手动触发机审超时兜底（定时任务每天也会跑） */
  @Post('content-check/sweep')
  async sweep() {
    const cleared = await this.tasks.sweepTimeouts();
    return { cleared };
  }
}

