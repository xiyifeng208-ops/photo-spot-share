import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../common/guards/jwt-auth.guard';
import { RoutesService } from './routes.service';

@Public()
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  list() { return this.routes.list(); }

  @Get(':id')
  detail(@Param('id') id: string) { return this.routes.detail(id); }
}
