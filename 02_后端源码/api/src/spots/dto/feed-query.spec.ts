import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListFavoritesQueryDto, ListFeedQueryDto } from './spot.dto';

describe('发现页筛选参数', () => {
  it('去掉关键词首尾空格后再检查长度', async () => {
    const dto = plainToInstance(ListFeedQueryDto, { keyword: `  ${'字'.repeat(100)}  ` });
    expect(dto.keyword).toHaveLength(100);
    expect(await validate(dto)).toHaveLength(0);
  });
  it.each([{ keyword: '字'.repeat(101) }, { keyword: ['a', 'b'] }, { province: '字'.repeat(65) }, { district: ['仙桃市'] }])('拒绝不合法参数 %j', async query => {
    expect((await validate(plainToInstance(ListFeedQueryDto, query))).length).toBeGreaterThan(0);
  });

  it('CSV 拍摄条件去空格去重，并把难度转换为数字', async () => {
    const dto = plainToInstance(ListFeedQueryDto, {
      bestTimes: 'sunrise, night,sunrise', bestSeasons: 'spring,autumn',
      focalLengths: 'tele,standard', difficulties: '1, 3,1',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.bestTimes).toEqual(['sunrise', 'night']);
    expect(dto.bestSeasons).toEqual(['spring', 'autumn']);
    expect(dto.focalLengths).toEqual(['tele', 'standard']);
    expect(dto.difficulties).toEqual([1, 3]);
  });

  it('未指定或空白拍摄条件表示不限', async () => {
    const dto = plainToInstance(ListFeedQueryDto, { bestTimes: '', bestSeasons: ' ', focalLengths: '', difficulties: '' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.bestTimes).toEqual([]);
    expect(dto.difficulties).toEqual([]);
    expect(await validate(plainToInstance(ListFeedQueryDto, {}))).toHaveLength(0);
  });

  it.each([
    { bestTimes: 'dawn' }, { bestSeasons: 'all' }, { focalLengths: 'phone' },
    { difficulties: '0' }, { difficulties: '4' }, { difficulties: '1.0' }, { difficulties: '01' },
    { bestTimes: 'night,' }, { bestSeasons: 'spring,,summer' },
    { bestTimes: ['night', 'sunset'] }, { bestTimes: { x: 'night' } },
    { difficulties: ['1', '2'] }, { focalLengths: 'tele'.repeat(51) },
  ])('拒绝非法 CSV 拍摄条件 %j', async query => {
    expect((await validate(plainToInstance(ListFeedQueryDto, query))).length).toBeGreaterThan(0);
  });

  it('收藏区域参数限制长度和类型', async () => {
    expect(await validate(plainToInstance(ListFavoritesQueryDto, { province: '湖北省', district: '仙桃市' }))).toHaveLength(0);
    expect((await validate(plainToInstance(ListFavoritesQueryDto, { city: ['上海市'] }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ListFavoritesQueryDto, { province: '字'.repeat(65) }))).length).toBeGreaterThan(0);
  });
});
