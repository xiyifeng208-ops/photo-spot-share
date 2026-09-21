import { DatabaseService } from '../database/database.service';
import { ShootingTimesService } from './shooting-times.service';

describe('拍摄时间服务只读取公开坐标', () => {
  const queryOne = jest.fn();
  const service = new ShootingTimesService({ queryOne } as unknown as DatabaseService);
  beforeEach(() => queryOne.mockReset());

  it('参数化查询只获取公开作品坐标，不使用详情或更新浏览量', async () => {
    queryOne.mockResolvedValue({ lat: 31.23, lng: 121.49 });
    const result = await service.getForSpot('spot-id', '2026-09-18');
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(queryOne).toHaveBeenCalledWith("SELECT lat, lng FROM spots WHERE id = $1 AND status = 'active'", ['spot-id']);
    expect(result.sunrise).not.toBeNull();
  });
  it('不存在或非公开作品返回 404', async () => {
    queryOne.mockResolvedValue(null);
    await expect(service.getForSpot('spot-id', '2026-09-18')).rejects.toMatchObject({ status: 404 });
  });
  it('非法日期在查询数据库前拒绝', async () => {
    await expect(service.getForSpot('spot-id', '2026-02-30')).rejects.toMatchObject({ status: 400 });
    expect(queryOne).not.toHaveBeenCalled();
  });
  it('数据库故障不是伪装的空时段', async () => {
    queryOne.mockRejectedValue(new Error('database offline'));
    await expect(service.getForSpot('spot-id', '2026-09-18')).rejects.toThrow('database offline');
  });
});
