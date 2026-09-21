import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { DatabaseService } from '../database/database.service';
import { calculateShootingTimes, parseShootingDate, type ShootingTimes } from './solar-calculator';

@Injectable()
export class ShootingTimesService {
  constructor(private readonly db: DatabaseService) {}

  async getForSpot(id: string, date?: unknown): Promise<ShootingTimes> {
    const selectedDate = parseShootingDate(date);
    // Dedicated read-only query: author access to hidden details does not grant access here,
    // and calculating a date must never increment the spot's view count.
    const spot = await this.db.queryOne<{ lat: number; lng: number }>(
      "SELECT lat, lng FROM spots WHERE id = $1 AND status = 'active'", [id],
    );
    if (!spot) throw AppException.notFound('机位不存在或暂不可用');
    return calculateShootingTimes(selectedDate, Number(spot.lat), Number(spot.lng));
  }
}
